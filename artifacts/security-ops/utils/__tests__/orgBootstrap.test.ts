/**
 * Multi-org bootstrap + switch logic tests.
 *
 * These exercise the decision logic OrgProvider runs at launch and on "Switch
 * organization", with every storage / routing dependency injected as a fake.
 * The guarantees under test protect against cross-customer data bleed:
 *   - a stored org is re-applied;
 *   - a legacy single-tenant session (token, no org) is migrated onto WCSG so an
 *     app update never strands the user on /connect;
 *   - a fresh install with no token resolves to null → the provider gates
 *     /connect until the user enters a code;
 *   - switching forgets the org and resets routing back to the default.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapOrg,
  performSwitchOrg,
  runSwitchOrgFlow,
  runSwitchToCodeFlow,
  type OrgBootstrapDeps,
  type OrgSwitchDeps,
} from "../orgBootstrap";
import type { SelectedOrg } from "../orgConfig";

const WCSG: SelectedOrg = {
  code: "wcsg",
  name: "Williams Council Security Group",
  apiBaseUrl: "https://wcsg.example.app",
};

const ACME: SelectedOrg = {
  code: "acme",
  name: "Acme Security",
  apiBaseUrl: "https://acme.example.app",
};

function buildBootstrapDeps(opts?: {
  stored?: SelectedOrg | null;
  token?: string | null;
}): { deps: OrgBootstrapDeps; saveSelectedOrg: ReturnType<typeof vi.fn>; applyOrgRouting: ReturnType<typeof vi.fn> } {
  const saveSelectedOrg = vi.fn(async () => undefined);
  const applyOrgRouting = vi.fn();
  const deps: OrgBootstrapDeps = {
    loadSelectedOrg: vi.fn(async () => opts?.stored ?? null),
    saveSelectedOrg,
    getAuthToken: vi.fn(async () => opts?.token ?? null),
    legacyDefaultOrg: WCSG,
    applyOrgRouting,
  };
  return { deps, saveSelectedOrg, applyOrgRouting };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("bootstrapOrg", () => {
  it("re-applies a previously selected org without re-saving it", async () => {
    const { deps, saveSelectedOrg, applyOrgRouting } = buildBootstrapDeps({ stored: ACME });
    const result = await bootstrapOrg(deps);
    expect(result).toEqual(ACME);
    expect(applyOrgRouting).toHaveBeenCalledWith(ACME.apiBaseUrl);
    expect(saveSelectedOrg).not.toHaveBeenCalled();
  });

  it("migrates a legacy single-tenant session (token, no org) onto WCSG", async () => {
    const { deps, saveSelectedOrg, applyOrgRouting } = buildBootstrapDeps({
      stored: null,
      token: "existing-jwt",
    });
    const result = await bootstrapOrg(deps);
    expect(result).toEqual(WCSG);
    // Persisted so the migration is sticky, and routing applied before any
    // authed request fires.
    expect(saveSelectedOrg).toHaveBeenCalledWith(WCSG);
    expect(applyOrgRouting).toHaveBeenCalledWith(WCSG.apiBaseUrl);
  });

  it("returns null (gate /connect) for a fresh install with no org and no token", async () => {
    const { deps, saveSelectedOrg, applyOrgRouting } = buildBootstrapDeps({
      stored: null,
      token: null,
    });
    const result = await bootstrapOrg(deps);
    expect(result).toBeNull();
    // Nothing persisted and, crucially, no backend applied — the app stays on
    // the default until the user resolves a code.
    expect(saveSelectedOrg).not.toHaveBeenCalled();
    expect(applyOrgRouting).not.toHaveBeenCalled();
  });

  it("prefers a stored org over legacy migration even when a token is present", async () => {
    const { deps, saveSelectedOrg, applyOrgRouting } = buildBootstrapDeps({
      stored: ACME,
      token: "existing-jwt",
    });
    const result = await bootstrapOrg(deps);
    expect(result).toEqual(ACME);
    expect(applyOrgRouting).toHaveBeenCalledWith(ACME.apiBaseUrl);
    expect(saveSelectedOrg).not.toHaveBeenCalled();
  });
});

describe("performSwitchOrg", () => {
  it("forgets the org and resets routing back to the default", async () => {
    const calls: string[] = [];
    const clearSelectedOrg = vi.fn(async () => {
      calls.push("clear");
    });
    const resetOrgRouting = vi.fn(() => {
      calls.push("reset");
    });
    const deps: OrgSwitchDeps = { clearSelectedOrg, resetOrgRouting };

    await performSwitchOrg(deps);

    expect(clearSelectedOrg).toHaveBeenCalledTimes(1);
    expect(resetOrgRouting).toHaveBeenCalledTimes(1);
    // Stored org is dropped before routing is reset.
    expect(calls).toEqual(["clear", "reset"]);
  });
});

describe("runSwitchOrgFlow", () => {
  it("logs out, switches org, then navigates — in that order", async () => {
    const calls: string[] = [];
    const logout = vi.fn(async () => {
      calls.push("logout");
    });
    const switchOrg = vi.fn(async () => {
      calls.push("switch");
    });
    const navigateToConnect = vi.fn(() => {
      calls.push("navigate");
    });

    await runSwitchOrgFlow({ logout, switchOrg, navigateToConnect });

    // Logout MUST run first so the request hits the current backend before the
    // origin is reset; navigation happens last.
    expect(calls).toEqual(["logout", "switch", "navigate"]);
  });

  it("still switches org and navigates when logout fails (best-effort)", async () => {
    const calls: string[] = [];
    const logout = vi.fn(async () => {
      calls.push("logout");
      throw new Error("network down");
    });
    const switchOrg = vi.fn(async () => {
      calls.push("switch");
    });
    const navigateToConnect = vi.fn(() => {
      calls.push("navigate");
    });

    await expect(
      runSwitchOrgFlow({ logout, switchOrg, navigateToConnect }),
    ).resolves.toBeUndefined();

    // A failed logout must not strand the user on the old backend.
    expect(calls).toEqual(["logout", "switch", "navigate"]);
  });

  it("clears the session token, the React Query cache, and the runtime origin — no cross-customer bleed", async () => {
    // Model the device/session state the switch must scrub clean. The fakes
    // mirror the real side effects: AuthContext.logout removes the token + clears
    // the query cache; OrgContext's resetOrgRouting clears the runtime origin.
    const state = {
      token: "old-jwt" as string | null,
      queryCacheCleared: false,
      runtimeOrigin: ACME.apiBaseUrl as string | null,
    };
    const order: string[] = [];

    // Stand-in for AuthContext.logout's documented effects.
    const logout = vi.fn(async () => {
      order.push("token-cleared");
      state.token = null;
      order.push("query-cache-cleared");
      state.queryCacheCleared = true;
    });

    // Real org-switch primitive driving a routing reset that scrubs the origin.
    const switchOrg = () =>
      performSwitchOrg({
        clearSelectedOrg: vi.fn(async () => undefined),
        resetOrgRouting: vi.fn(() => {
          order.push("runtime-origin-reset");
          state.runtimeOrigin = null;
        }),
      });

    await runSwitchOrgFlow({ logout, switchOrg, navigateToConnect: vi.fn() });

    expect(state.token).toBeNull();
    expect(state.queryCacheCleared).toBe(true);
    expect(state.runtimeOrigin).toBeNull();
    // Token + query cache are scrubbed while the OLD origin is still applied,
    // before routing is reset.
    expect(order).toEqual([
      "token-cleared",
      "query-cache-cleared",
      "runtime-origin-reset",
    ]);
  });
});

describe("runSwitchToCodeFlow", () => {
  it("tears down the current org, resolves the new code, then navigates — in that order", async () => {
    const calls: string[] = [];
    const switchOrg = vi.fn(async () => {
      calls.push("switch");
    });
    const selectOrg = vi.fn(async () => {
      calls.push("select");
    });
    const navigateToLogin = vi.fn(() => {
      calls.push("navigate");
    });
    const setBusy = vi.fn();
    const setError = vi.fn();

    await runSwitchToCodeFlow("acme", {
      switchOrg,
      selectOrg,
      navigateToLogin,
      setBusy,
      setError,
    });

    // The current org MUST be torn down (logout + session/cache/route reset)
    // BEFORE the new org is resolved + applied, and navigation happens last.
    expect(calls).toEqual(["switch", "select", "navigate"]);
    expect(selectOrg).toHaveBeenCalledWith("acme");
    expect(setError).toHaveBeenCalledWith(null);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });

  it("trims the code before resolving it", async () => {
    const selectOrg = vi.fn(async () => undefined);
    await runSwitchToCodeFlow("  acme  ", {
      switchOrg: vi.fn(async () => undefined),
      selectOrg,
      navigateToLogin: vi.fn(),
      setBusy: vi.fn(),
      setError: vi.fn(),
    });
    expect(selectOrg).toHaveBeenCalledWith("acme");
  });

  it("does nothing for a blank code", async () => {
    const switchOrg = vi.fn(async () => undefined);
    const setBusy = vi.fn();
    await runSwitchToCodeFlow("   ", {
      switchOrg,
      selectOrg: vi.fn(async () => undefined),
      navigateToLogin: vi.fn(),
      setBusy,
      setError: vi.fn(),
    });
    expect(switchOrg).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
  });

  it("surfaces the error and does NOT navigate when the new code fails to resolve", async () => {
    const calls: string[] = [];
    const switchOrg = vi.fn(async () => {
      calls.push("switch");
    });
    const selectOrg = vi.fn(async () => {
      throw new Error("We couldn't find that organization code.");
    });
    const navigateToLogin = vi.fn(() => {
      calls.push("navigate");
    });
    const setError = vi.fn();
    const setBusy = vi.fn();

    await runSwitchToCodeFlow("bad-code", {
      switchOrg,
      selectOrg,
      navigateToLogin,
      setBusy,
      setError,
    });

    // The old org was already torn down (so no stale session bleeds), but a
    // failed resolve must leave the user on /connect with the error, never
    // navigated on, and never busy.
    expect(calls).toEqual(["switch"]);
    expect(navigateToLogin).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "We couldn't find that organization code.",
    );
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });
});
