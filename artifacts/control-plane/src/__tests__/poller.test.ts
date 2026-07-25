/**
 * Health-poller probe behavior.
 *
 * `probeBackend` is the DB-free core of the fleet poller. These tests pin two
 * contracts the operator dashboard depends on:
 *   - a modern backend reporting /api/version is online with its build version;
 *   - an OLDER customer backend that predates /api/version (404 there) must
 *     degrade gracefully to /api/healthz — reachable => online with an UNKNOWN
 *     (null) version, NOT a false "offline".
 */

import { afterEach, describe, expect, it } from "vitest";
import { fetchAgreementsSnapshot, fetchCustomerConfigSnapshot, probeBackend } from "../poller";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function res(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as unknown as Response;
}

function route(map: { version?: Response | Error; healthz?: Response | Error }) {
  globalThis.fetch = (async (url: string) => {
    const target = url.endsWith("/api/version")
      ? map.version
      : url.endsWith("/api/healthz")
        ? map.healthz
        : undefined;
    if (target instanceof Error) throw target;
    if (!target) throw new Error(`unexpected url ${url}`);
    return target;
  }) as unknown as typeof fetch;
}

describe("probeBackend", () => {
  it("reports online + version for a modern backend", async () => {
    route({ version: res(200, { version: "abc1234", builtAt: "2026-06-25T00:00:00Z" }) });
    const r = await probeBackend("http://customer.test");
    expect(r.status).toBe("online");
    expect(r.version).toBe("abc1234");
    expect(r.builtAt).toBe("2026-06-25T00:00:00Z");
    expect(r.seen).toBe(true);
    expect(r.lastError).toBeNull();
  });

  it("degrades gracefully for a legacy backend without /api/version", async () => {
    route({ version: res(404), healthz: res(200, { status: "ok" }) });
    const r = await probeBackend("http://legacy.test");
    expect(r.status).toBe("online");
    expect(r.version).toBeNull(); // unknown — not yet remotely manageable
    expect(r.seen).toBe(true);
    expect(r.lastError).toMatch(/legacy/i);
  });

  it("is offline when version 404s and healthz is unreachable", async () => {
    route({ version: res(404), healthz: res(503) });
    const r = await probeBackend("http://down.test");
    expect(r.status).toBe("offline");
    expect(r.version).toBeNull();
    expect(r.seen).toBe(false);
    expect(r.lastError).toBe("HTTP 503");
  });

  it("is offline (no healthz fallback) for non-404 version errors", async () => {
    route({ version: res(500) });
    const r = await probeBackend("http://err.test");
    expect(r.status).toBe("offline");
    expect(r.lastError).toBe("HTTP 500");
    expect(r.seen).toBe(false);
  });

  it("is offline when the host is unreachable", async () => {
    route({ version: new Error("fetch failed") });
    const r = await probeBackend("http://unreachable.test");
    expect(r.status).toBe("offline");
    expect(r.lastError).toBe("fetch failed");
    expect(r.seen).toBe(false);
  });
});

/**
 * Agreement snapshot fetch semantics (drives the fleet "Agreements" column):
 *   - stored JSON string on success;
 *   - `null` (clear) when no secret or the backend predates the surface (404);
 *   - `undefined` (keep last snapshot) on transient errors / network failure.
 */
describe("fetchAgreementsSnapshot", () => {
  function agreementsRoute(target: Response | Error) {
    globalThis.fetch = (async (url: string) => {
      if (!url.endsWith("/api/control-plane/agreements")) throw new Error(`unexpected url ${url}`);
      if (target instanceof Error) throw target;
      return target;
    }) as unknown as typeof fetch;
  }

  it("returns null (status unknowable) without a management secret", async () => {
    expect(await fetchAgreementsSnapshot("http://customer.test", null)).toBeNull();
  });

  it("stores a snapshot with fetchedAt + slots on success", async () => {
    const slots = {
      msa: { signed: true, guarantyExecuted: true },
      user_agreement: { signed: false, guarantyExecuted: null },
    };
    agreementsRoute(res(200, { agreements: slots }));
    const raw = await fetchAgreementsSnapshot("http://customer.test", "secret");
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw as string);
    expect(typeof parsed.fetchedAt).toBe("string");
    expect(parsed.slots).toEqual(slots);
  });

  it("clears the snapshot (null) for a legacy backend without the surface (404)", async () => {
    agreementsRoute(res(404, { message: "not found" }));
    expect(await fetchAgreementsSnapshot("http://legacy.test", "secret")).toBeNull();
  });

  it("keeps the last snapshot (undefined) on transient server errors", async () => {
    agreementsRoute(res(503, { error: "inert" }));
    expect(await fetchAgreementsSnapshot("http://busy.test", "secret")).toBeUndefined();
  });

  it("keeps the last snapshot (undefined) on network failure", async () => {
    agreementsRoute(new Error("fetch failed"));
    expect(await fetchAgreementsSnapshot("http://unreachable.test", "secret")).toBeUndefined();
  });
});

/**
 * Commercial-config snapshot fetch semantics (drives the fleet "Plan" column +
 * MRR/tier overview):
 *   - stored JSON string ({ fetchedAt, config }) on success;
 *   - a snapshot with config:null when the backend is reached but has no config;
 *   - `null` (clear) when no secret or the backend predates the surface (404);
 *   - `undefined` (keep last snapshot) on transient errors / network failure.
 */
describe("fetchCustomerConfigSnapshot", () => {
  function settingsRoute(target: Response | Error) {
    globalThis.fetch = (async (url: string) => {
      if (!url.endsWith("/api/control-plane/settings")) throw new Error(`unexpected url ${url}`);
      if (target instanceof Error) throw target;
      return target;
    }) as unknown as typeof fetch;
  }

  it("returns null (plan unknowable) without a management secret", async () => {
    expect(await fetchCustomerConfigSnapshot("http://customer.test", null)).toBeNull();
  });

  it("stores a snapshot with fetchedAt + config on success", async () => {
    const config = { planTier: "professional", monthlyPriceCents: 89900 };
    settingsRoute(res(200, { customerConfig: config }));
    const raw = await fetchCustomerConfigSnapshot("http://customer.test", "secret");
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw as string);
    expect(typeof parsed.fetchedAt).toBe("string");
    expect(parsed.config).toEqual(config);
  });

  it("stores a snapshot with config:null when the backend has no config saved", async () => {
    settingsRoute(res(200, { customerConfig: null }));
    const raw = await fetchCustomerConfigSnapshot("http://customer.test", "secret");
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).config).toBeNull();
  });

  it("clears the snapshot (null) for a legacy backend without the surface (404)", async () => {
    settingsRoute(res(404, { message: "not found" }));
    expect(await fetchCustomerConfigSnapshot("http://legacy.test", "secret")).toBeNull();
  });

  it("keeps the last snapshot (undefined) on transient server errors", async () => {
    settingsRoute(res(503, { error: "inert" }));
    expect(await fetchCustomerConfigSnapshot("http://busy.test", "secret")).toBeUndefined();
  });

  it("keeps the last snapshot (undefined) on network failure", async () => {
    settingsRoute(new Error("fetch failed"));
    expect(await fetchCustomerConfigSnapshot("http://unreachable.test", "secret")).toBeUndefined();
  });
});
