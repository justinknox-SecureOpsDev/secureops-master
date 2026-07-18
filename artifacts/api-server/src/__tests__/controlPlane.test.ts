/**
 * Remote control-plane management surface — HMAC auth contract.
 *
 * Pins the security posture the master control plane relies on:
 *   - GET /api/version is public and reports build identity;
 *   - /api/control-plane/* is INERT (503) until CONTROL_PLANE_SHARED_SECRET set;
 *   - a missing / bad signature is rejected (401);
 *   - a valid signature can read settings and write brand + feature overrides,
 *     reusing the exact same zod validation as the in-app super-admin routes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, platformBrandConfigTable, platformFeatureOverridesTable } from "@workspace/db";
import app from "../app";
import { signControlPlanePayload, CONTROL_PLANE_SIGNATURE_HEADER } from "../lib/controlPlaneAuth";

const SECRET = "control-plane-integration-test-secret";
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env.CONTROL_PLANE_SHARED_SECRET;
});

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.CONTROL_PLANE_SHARED_SECRET;
  else process.env.CONTROL_PLANE_SHARED_SECRET = prevSecret;
  // Clean up anything this suite wrote so it never leaks into other tests.
  await db.delete(platformBrandConfigTable).where(eq(platformBrandConfigTable.id, "singleton"));
  await db
    .delete(platformFeatureOverridesTable)
    .where(eq(platformFeatureOverridesTable.featureKey, "chat"));
});

afterEach(() => {
  // Default each test back to "configured" unless it opts out.
  process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
});

describe("GET /api/version", () => {
  it("is public and reports build identity", async () => {
    const res = await request(app).get("/api/version");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.builtAt).toBe("string");
  });
});

describe("/api/control-plane (HMAC)", () => {
  it("returns 503 (inert) when no shared secret is configured", async () => {
    delete process.env.CONTROL_PLANE_SHARED_SECRET;
    const res = await request(app).get("/api/control-plane/settings");
    expect(res.status).toBe(503);
  });

  it("rejects a request with no signature (401)", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const res = await request(app).get("/api/control-plane/settings");
    expect(res.status).toBe(401);
  });

  it("rejects a request with a bad signature (401)", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const res = await request(app)
      .get("/api/control-plane/settings")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, "0".repeat(64));
    expect(res.status).toBe(401);
  });

  it("reads settings with a valid signature over the empty body", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const sig = signControlPlanePayload("", SECRET);
    const res = await request(app)
      .get("/api/control-plane/settings")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("features");
    expect(Array.isArray(res.body.features)).toBe(true);
    expect(res.body).toHaveProperty("version");
  });

  it("writes a brand override with a valid signature", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const body = {
      companyName: "Remote-Managed Co",
      shortName: "RMC",
      tagline: "",
      appName: "",
      colorNavy: "#102030",
      colorGold: "",
      colorCream: "",
      billingEmail: "",
      hrEmail: "",
      adminNotifyEmail: "",
      logoDataUrl: "",
    };
    const payload = JSON.stringify(body);
    const sig = signControlPlanePayload(payload, SECRET);
    const res = await request(app)
      .put("/api/control-plane/brand")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.brand).toMatchObject({ companyName: "Remote-Managed Co", colorNavy: "#102030" });
  });

  it("rejects an invalid brand payload (400) even with a valid signature", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const body = { colorNavy: "not-a-hex" };
    const payload = JSON.stringify(body);
    const sig = signControlPlanePayload(payload, SECRET);
    const res = await request(app)
      .put("/api/control-plane/brand")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(400);
  });

  it("toggles a feature flag with a valid signature", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const body = { updates: [{ key: "chat", enabled: false }] };
    const payload = JSON.stringify(body);
    const sig = signControlPlanePayload(payload, SECRET);
    const res = await request(app)
      .put("/api/control-plane/features")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(200);
    const chat = res.body.features.find((f: { key: string }) => f.key === "chat");
    expect(chat).toBeTruthy();
    expect(chat.enabled).toBe(false);
  });
});
