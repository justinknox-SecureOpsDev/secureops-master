/**
 * Pre-login connect-screen submit flow tests.
 *
 * The connect screen (app/connect.tsx) is the user-facing entry point for a new
 * device: a user types their organization code and the handler resolves it to a
 * backend before routing on to sign-in. These exercise that handler's decision
 * logic with every dependency injected as a fake (no RN rendering), matching the
 * orgBootstrap test style.
 *
 * The guarantees under test protect a new user from being stranded:
 *   - a valid code resolves + applies the org, then routes to /login;
 *   - a rejected resolveOrgCode surfaces the thrown user-facing message and does
 *     NOT navigate (the user stays on /connect with a clear error);
 *   - a thrown error without a message falls back to a generic message;
 *   - the busy flag is always cleared so the form stays usable;
 *   - a blank / whitespace code is a no-op.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runConnectOrgFlow,
  CONNECT_ORG_FALLBACK_ERROR,
  type ConnectOrgFlowDeps,
} from "../orgBootstrap";
import type { SelectedOrg } from "../orgConfig";

const ACME: SelectedOrg = {
  code: "acme",
  name: "Acme Security",
  apiBaseUrl: "https://acme.example.app",
};

function buildDeps(opts?: {
  selectOrg?: ConnectOrgFlowDeps["selectOrg"];
}): {
  deps: ConnectOrgFlowDeps;
  selectOrg: ReturnType<typeof vi.fn>;
  navigateToLogin: ReturnType<typeof vi.fn>;
  setBusy: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
} {
  const selectOrg = vi.fn(
    opts?.selectOrg ?? (async () => ACME),
  );
  const navigateToLogin = vi.fn();
  const setBusy = vi.fn();
  const setError = vi.fn();
  return {
    deps: { selectOrg, navigateToLogin, setBusy, setError },
    selectOrg,
    navigateToLogin,
    setBusy,
    setError,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runConnectOrgFlow", () => {
  it("resolves a valid code, then routes on to /login", async () => {
    const { deps, selectOrg, navigateToLogin, setBusy, setError } = buildDeps();

    await runConnectOrgFlow("acme", deps);

    expect(selectOrg).toHaveBeenCalledWith("acme");
    expect(navigateToLogin).toHaveBeenCalledTimes(1);
    // Spinner on for the request, error cleared, spinner off at the end.
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(setError).toHaveBeenCalledWith(null);
    expect(setError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it("trims surrounding whitespace before resolving", async () => {
    const { deps, selectOrg, navigateToLogin } = buildDeps();

    await runConnectOrgFlow("  acme  ", deps);

    expect(selectOrg).toHaveBeenCalledWith("acme");
    expect(navigateToLogin).toHaveBeenCalledTimes(1);
  });

  it("surfaces the thrown user-facing message and does NOT navigate on a bad code", async () => {
    const { deps, navigateToLogin, setError, setBusy } = buildDeps({
      selectOrg: async () => {
        throw new Error("We don't recognize that organization code.");
      },
    });

    await runConnectOrgFlow("nope", deps);

    expect(setError).toHaveBeenCalledWith(
      "We don't recognize that organization code.",
    );
    // The user stays on /connect — a half-resolved org must never route on.
    expect(navigateToLogin).not.toHaveBeenCalled();
    // Busy is still cleared so the form is usable for a retry.
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("falls back to a generic message when the error has no message", async () => {
    const { deps, navigateToLogin, setError } = buildDeps({
      selectOrg: async () => {
        // e.g. a non-Error rejection with no .message
        throw {};
      },
    });

    await runConnectOrgFlow("acme", deps);

    expect(setError).toHaveBeenCalledWith(CONNECT_ORG_FALLBACK_ERROR);
    expect(navigateToLogin).not.toHaveBeenCalled();
  });

  it("clears the busy flag even when resolution throws", async () => {
    const { deps, setBusy } = buildDeps({
      selectOrg: async () => {
        throw new Error("network down");
      },
    });

    await runConnectOrgFlow("acme", deps);

    // The finally block must always turn the spinner back off.
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });

  it("is a no-op for a blank / whitespace-only code", async () => {
    const { deps, selectOrg, navigateToLogin, setBusy, setError } = buildDeps();

    await runConnectOrgFlow("   ", deps);

    expect(selectOrg).not.toHaveBeenCalled();
    expect(navigateToLogin).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
});
