/**
 * Redeploy brand-readiness regression test.
 *
 * The bug: the API server started accepting requests (`server.listen`) BEFORE
 * the super-admin brand overrides finished loading from the DB. So the very
 * first `GET /api/brand` after a redeploy could return the env-baseline
 * `COMPANY_NAME` — a stale white-label placeholder ("SecureOps Platform" on the
 * RGP fork) — instead of the tenant's real name stored as a DB override. The
 * admin portal caches the first value it fetches for the whole session, so the
 * placeholder stuck until a hard refresh.
 *
 * The fix: `GET /api/brand` awaits a shared config-readiness signal
 * (initialised at boot) that resolves once the brand + feature overrides are
 * loaded (or a short timeout elapses). This suite proves the endpoint waits for
 * that signal, so the first post-boot response already reflects the DB override.
 *
 * Follows the api-server test conventions: single shared DB, no file
 * parallelism (see vitest.config.ts). The `platform_brand_config` singleton row
 * and the in-memory `brand` object are global, so this suite resets both before
 * each test and restores them afterwards.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, platformBrandConfigTable } from "@workspace/db";
import app from "../app";
import { brand, applyBrandOverrides, loadBrandOverridesFromDb } from "../lib/brandConfig";
import { __setConfigReadinessForTests } from "../lib/configReadiness";

async function resetBrandAndReadiness(): Promise<void> {
  await db
    .delete(platformBrandConfigTable)
    .where(eq(platformBrandConfigTable.id, "singleton"));
  applyBrandOverrides(null); // back to the env baseline, as on a fresh process
  __setConfigReadinessForTests(null); // as if the server has not booted yet
}

beforeEach(resetBrandAndReadiness);
afterAll(resetBrandAndReadiness);

describe("GET /api/brand — brand readiness after redeploy", () => {
  it("serves the DB company-name override on the FIRST request after boot, not the env default", async () => {
    const envDefaultName = brand.companyName;
    const overrideName = `Redeploy Brand ${randomUUID().slice(0, 8)}`;
    expect(overrideName).not.toBe(envDefaultName);

    // A super-admin previously saved a white-label override in the DB.
    await db
      .insert(platformBrandConfigTable)
      .values({ id: "singleton", companyName: overrideName });

    // Simulate boot with the override load still in flight: the readiness
    // signal only completes the (real) DB load once we open `gate`. This lets
    // us drive the boot-window ordering deterministically.
    let startLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      startLoad = resolve;
    });
    __setConfigReadinessForTests(gate.then(() => loadBrandOverridesFromDb()));

    const pending = request(app).get("/api/brand");

    // Give a non-awaiting (buggy) handler every chance to have already
    // responded with the baseline. The override load is still gated shut, so
    // the in-memory brand is guaranteed to still be the env default here — this
    // is exactly the boot window the bug exposed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(brand.companyName).toBe(envDefaultName);

    // Let the real DB override load run to completion, then read the response.
    // A correct handler waited for readiness and now sees the override.
    startLoad();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe(overrideName);
  });

  it("responds immediately with the env baseline when the readiness signal is unset (never hangs)", async () => {
    const envDefaultName = brand.companyName;
    __setConfigReadinessForTests(null);

    const res = await request(app).get("/api/brand");

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe(envDefaultName);
  });
});
