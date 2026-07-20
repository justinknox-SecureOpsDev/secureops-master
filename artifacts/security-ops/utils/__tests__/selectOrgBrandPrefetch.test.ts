/**
 * "No flash" brand-prefetch invariant for org connect.
 *
 * OrgContext.selectOrg / selectDefaultOrg both run applySelectedOrg
 * (utils/orgBootstrap), which must AWAIT prefetchBrand() before resolving so
 * the in-memory brand cache (hooks/useFeatures) already holds the tenant's
 * colors when the caller navigates to the login screen. A refactor that turns
 * the eager fetch into a lazy one would reintroduce a flash of the default
 * WCSG look — these tests are the CI signal for that regression.
 *
 * The REAL prefetchBrand from hooks/useFeatures is exercised (not a fake):
 * global fetch is stubbed, and the RN-only modules it touches (storage, api)
 * are mocked so the hook module loads in the node test environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins for the RN-only modules useFeatures imports.
const memoryStore = new Map<string, string>();
vi.mock("@/utils/storage", () => ({
  storage: {
    get: async (k: string) => memoryStore.get(k) ?? null,
    set: async (k: string, v: string) => void memoryStore.set(k, v),
    remove: async (k: string) => void memoryStore.delete(k),
  },
}));
vi.mock("@/utils/api", () => ({
  // Simulate a connected native device: brandActive() must be true so
  // prefetchBrand actually fetches.
  isReactNative: () => true,
  hasRuntimeApiOrigin: () => true,
  getApiBaseUrl: () => "https://acme.example.app/api",
}));

import {
  prefetchBrand,
  resetFeatureFlagsCache,
  getCachedBrandSnapshot,
} from "@/hooks/useFeatures";
import { applySelectedOrg, type SelectOrgDeps } from "../orgBootstrap";
import type { SelectedOrg } from "../orgConfig";

const ACME: SelectedOrg = {
  code: "acme",
  name: "Acme Security",
  apiBaseUrl: "https://acme.example.app",
};

const ACME_BRAND_RESPONSE = {
  companyName: "Acme Security",
  shortName: "Acme",
  appName: "AcmeOps",
  colorNavy: "#101820",
  colorGold: "#ff8800",
  colorCream: "#fff2dd",
  features: {},
  logoDataUrl: null,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function buildDeps(prefetch: () => Promise<void> = prefetchBrand): {
  deps: SelectOrgDeps;
  saveSelectedOrg: ReturnType<typeof vi.fn>;
  applyOrgRouting: ReturnType<typeof vi.fn>;
} {
  const saveSelectedOrg = vi.fn(async () => {});
  const applyOrgRouting = vi.fn();
  return {
    deps: { saveSelectedOrg, applyOrgRouting, prefetchBrand: prefetch },
    saveSelectedOrg,
    applyOrgRouting,
  };
}

beforeEach(() => {
  memoryStore.clear();
  // Fresh module cache state before every test (same reset OrgContext runs via
  // applyOrgRouting → resetFeatureFlagsCache in production).
  resetFeatureFlagsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("applySelectedOrg brand prefetch (no-flash invariant)", () => {
  it("does not resolve until the brand fetch has settled, and the cache holds the tenant brand at resolution", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { deps } = buildDeps();
    let settled = false;
    const flow = applySelectedOrg(ACME, deps).then((org) => {
      settled = true;
      return org;
    });

    // Let microtasks run: save + routing done, brand fetch in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith("https://acme.example.app/api/brand");
    // The flow must still be pending — the eager fetch is being awaited.
    expect(settled).toBe(false);
    expect(getCachedBrandSnapshot()).toBeNull();

    gate.resolve(okJsonResponse(ACME_BRAND_RESPONSE));
    const result = await flow;

    expect(result).toEqual(ACME);
    // THE invariant: by the time selectOrg's promise resolves (i.e. before the
    // caller can navigate to login), the in-memory brand cache is populated
    // with the TENANT's brand — no flash of the default look.
    const snapshot = getCachedBrandSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.brand.companyName).toBe("Acme Security");
    expect(snapshot!.colors.gold).toBe("#ff8800");
    expect(snapshot!.colors.navy).toBe("#101820");
  });

  it("applies routing BEFORE the brand fetch so the fetch targets the new backend", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("fetch");
        return okJsonResponse(ACME_BRAND_RESPONSE);
      }),
    );
    const { deps, applyOrgRouting } = buildDeps();
    applyOrgRouting.mockImplementation(() => order.push("routing"));

    await applySelectedOrg(ACME, deps);
    expect(order).toEqual(["routing", "fetch"]);
    expect(applyOrgRouting).toHaveBeenCalledWith("https://acme.example.app");
  });

  it("still resolves (and falls back to env brand) when the brand fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { deps } = buildDeps();

    const result = await applySelectedOrg(ACME, deps);
    expect(result).toEqual(ACME);
    // fetchFresh falls back to the env payload so the UI has SOMETHING cached.
    const snapshot = getCachedBrandSnapshot();
    expect(snapshot).not.toBeNull();
  });

  it("never rejects even if the injected prefetch itself rejects", async () => {
    const { deps } = buildDeps(async () => {
      throw new Error("boom");
    });
    await expect(applySelectedOrg(ACME, deps)).resolves.toEqual(ACME);
  });

  it("persists the org before anything else (relaunch safety)", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("fetch");
        return okJsonResponse(ACME_BRAND_RESPONSE);
      }),
    );
    const { deps, saveSelectedOrg, applyOrgRouting } = buildDeps();
    saveSelectedOrg.mockImplementation(async () => void order.push("save"));
    applyOrgRouting.mockImplementation(() => order.push("routing"));

    await applySelectedOrg(ACME, deps);
    expect(order).toEqual(["save", "routing", "fetch"]);
  });
});
