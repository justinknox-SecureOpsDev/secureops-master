/**
 * Multi-org client config tests: origin/code validation, directory resolution,
 * and persisted-org load/save. These are the client-side guards that keep the
 * app from ever routing to an unsafe or wrong backend (the server enforces the
 * same rules — see api-server __tests__/orgDirectory.test.ts).
 *
 * orgConfig imports the AsyncStorage-backed `storage` helper and the api-module
 * origin constant; both are mocked so the suite runs in plain Node. `fetch` is
 * stubbed per case for resolveOrgCode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      remove: vi.fn(async (k: string) => {
        store.delete(k);
      }),
    },
  };
});

vi.mock("@/utils/storage", () => ({ storage: mocks.storage }));
vi.mock("@/utils/api", () => ({ DEFAULT_NATIVE_ORIGIN: "https://wcsg.example.app" }));

import {
  normalizeOrigin,
  isValidOrgCode,
  normalizeOrgCode,
  resolveOrgCode,
  directoryResolveUrl,
  loadSelectedOrg,
  saveSelectedOrg,
  clearSelectedOrg,
  SELECTED_ORG_KEY,
} from "../orgConfig";

/** Build a minimal fetch Response stand-in. */
function fakeResponse(opts: { ok?: boolean; status: number; body?: unknown; throwJson?: boolean }) {
  return {
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    status: opts.status,
    json: async () => {
      if (opts.throwJson) throw new Error("bad json");
      return opts.body;
    },
  } as Response;
}

beforeEach(() => {
  mocks.store.clear();
  // Default to production semantics (https-only) unless a case opts into dev.
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL;
});

describe("normalizeOrigin", () => {
  it("returns the bare origin for a clean https url (drops trailing slash)", () => {
    expect(normalizeOrigin("https://acme.example.app")).toBe("https://acme.example.app");
    expect(normalizeOrigin("https://acme.example.app/")).toBe("https://acme.example.app");
    expect(normalizeOrigin("  https://acme.example.app  ")).toBe("https://acme.example.app");
  });

  it("rejects a url that carries a path, query, or fragment", () => {
    expect(normalizeOrigin("https://acme.example.app/api")).toBeNull();
    expect(normalizeOrigin("https://acme.example.app?x=1")).toBeNull();
    expect(normalizeOrigin("https://acme.example.app#frag")).toBeNull();
  });

  it("rejects plain http to a non-localhost host outside dev", () => {
    expect(normalizeOrigin("http://acme.example.app")).toBeNull();
  });

  it("rejects http to localhost / 127.0.0.1 outside dev (prod never routes over plaintext)", () => {
    expect(normalizeOrigin("http://localhost:8080")).toBeNull();
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBeNull();
  });

  it("allows plain http to any host when __DEV__ is set", () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    expect(normalizeOrigin("http://acme.example.app")).toBe("http://acme.example.app");
  });

  it("returns null for an unparseable url", () => {
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
  });
});

describe("org code validation", () => {
  it("lower-cases and trims", () => {
    expect(normalizeOrgCode("  ACME  ")).toBe("acme");
  });

  it("accepts short human-typeable codes and rejects junk", () => {
    expect(isValidOrgCode("acme")).toBe(true);
    expect(isValidOrgCode("wcsg-2")).toBe(true);
    expect(isValidOrgCode("ACME")).toBe(true); // normalized first
    expect(isValidOrgCode("a")).toBe(false); // too short
    expect(isValidOrgCode("bad code")).toBe(false);
    expect(isValidOrgCode("under_score")).toBe(false);
    expect(isValidOrgCode("-leading")).toBe(false);
    expect(isValidOrgCode("x".repeat(40))).toBe(false);
  });
});

describe("loadSelectedOrg / saveSelectedOrg / clearSelectedOrg", () => {
  it("round-trips a saved org through storage", async () => {
    const org = { code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" };
    await saveSelectedOrg(org);
    expect(mocks.store.get(SELECTED_ORG_KEY)).toBe(JSON.stringify(org));
    expect(await loadSelectedOrg()).toEqual(org);
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadSelectedOrg()).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    mocks.store.set(SELECTED_ORG_KEY, "{ not json");
    expect(await loadSelectedOrg()).toBeNull();
  });

  it("returns null when the stored apiBaseUrl is unsafe (non-https outside dev)", async () => {
    mocks.store.set(
      SELECTED_ORG_KEY,
      JSON.stringify({ code: "acme", name: "Acme", apiBaseUrl: "http://acme.example.app" }),
    );
    expect(await loadSelectedOrg()).toBeNull();
  });

  it("normalizes the stored apiBaseUrl down to an origin on load", async () => {
    mocks.store.set(
      SELECTED_ORG_KEY,
      JSON.stringify({ code: "acme", name: "", apiBaseUrl: "https://acme.example.app/" }),
    );
    expect(await loadSelectedOrg()).toEqual({
      code: "acme",
      name: "https://acme.example.app",
      apiBaseUrl: "https://acme.example.app",
    });
  });

  it("clears the stored org", async () => {
    await saveSelectedOrg({ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" });
    await clearSelectedOrg();
    expect(mocks.store.has(SELECTED_ORG_KEY)).toBe(false);
  });
});

describe("directoryResolveUrl", () => {
  it("targets EXPO_PUBLIC_ORG_DIRECTORY_URL when set and appends /resolve?code", () => {
    process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL =
      "https://control-plane.example.app/api/org-directory";
    expect(directoryResolveUrl("acme")).toBe(
      "https://control-plane.example.app/api/org-directory/resolve?code=acme",
    );
  });

  it("trims trailing slashes off the configured directory base", () => {
    process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL =
      "https://control-plane.example.app/api/org-directory///";
    expect(directoryResolveUrl("acme")).toBe(
      "https://control-plane.example.app/api/org-directory/resolve?code=acme",
    );
  });

  it("falls back to DEFAULT_NATIVE_ORIGIN/api/org-directory when the env is unset", () => {
    delete process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL;
    expect(directoryResolveUrl("acme")).toBe(
      "https://wcsg.example.app/api/org-directory/resolve?code=acme",
    );
  });

  it("falls back when the env is set to an empty string", () => {
    process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL = "";
    expect(directoryResolveUrl("acme")).toBe(
      "https://wcsg.example.app/api/org-directory/resolve?code=acme",
    );
  });

  it("url-encodes the code", () => {
    delete process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL;
    // Valid codes never contain these chars, but directoryResolveUrl is a pure
    // string builder with no validation, so it must still encode defensively.
    expect(directoryResolveUrl("a b&c")).toBe(
      "https://wcsg.example.app/api/org-directory/resolve?code=a%20b%26c",
    );
  });
});

describe("resolveOrgCode", () => {
  it("rejects an invalid code before hitting the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(resolveOrgCode("bad code")).rejects.toThrow(/valid organization code/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves a known code to its backend origin", async () => {
    const fetchSpy = vi.fn(async () =>
      fakeResponse({
        status: 200,
        body: { code: "acme", name: "Acme Security", apiBaseUrl: "https://acme.example.app" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const org = await resolveOrgCode("ACME");
    expect(org).toEqual({
      code: "acme",
      name: "Acme Security",
      apiBaseUrl: "https://acme.example.app",
    });
    // Regression guard: with no directory env set, the lookup must hit the
    // canonical-deployment fallback (not some other host), with the normalized code.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://wcsg.example.app/api/org-directory/resolve?code=acme",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("routes the lookup to EXPO_PUBLIC_ORG_DIRECTORY_URL when configured", async () => {
    process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL =
      "https://control-plane.example.app/api/org-directory";
    const fetchSpy = vi.fn(async () =>
      fakeResponse({
        status: 200,
        body: { code: "acme", name: "Acme Security", apiBaseUrl: "https://acme.example.app" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await resolveOrgCode("ACME");
    // The configured control-plane directory MUST be the target — a future change
    // that silently ignores this env knob would send every org-code lookup to the
    // wrong backend, and this assertion fails loudly if that happens.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://control-plane.example.app/api/org-directory/resolve?code=acme",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("throws a 'not found' error on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ status: 404 })));
    await expect(resolveOrgCode("ghost")).rejects.toThrow(/couldn't find/i);
  });

  it("throws a generic directory error on a non-404 failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ status: 500 })));
    await expect(resolveOrgCode("acme")).rejects.toThrow(/HTTP 500/i);
  });

  it("throws a connectivity error when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(resolveOrgCode("acme")).rejects.toThrow(/can't reach the directory/i);
  });

  it("throws when the directory returns an unexpected body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ status: 200, body: { nope: true } })));
    await expect(resolveOrgCode("acme")).rejects.toThrow(/unexpected response/i);
  });

  it("rejects a resolved-but-unsafe backend origin (non-https outside dev)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          status: 200,
          body: { code: "acme", name: "Acme", apiBaseUrl: "http://acme.example.app" },
        }),
      ),
    );
    await expect(resolveOrgCode("acme")).rejects.toThrow(/misconfigured/i);
  });
});
