import type { SelectedOrg } from "@/utils/orgConfig";

/**
 * Pure, dependency-injected multi-org bootstrap + switch logic, lifted out of
 * OrgContext so it can be unit-tested without rendering the React tree (the
 * component only wires these to the real storage / routing singletons).
 *
 * "Bootstrap" decides which backend a fresh app launch talks to:
 *   - a previously selected org is re-applied;
 *   - otherwise an existing single-tenant session (token but no org record) is
 *     silently migrated onto the legacy default org so an app update never
 *     strands a logged-in user on /connect;
 *   - otherwise nothing is applied → the caller gates /connect until the user
 *     enters a code.
 *
 * "Switch" forgets the current org and resets routing back to the default so no
 * cross-customer data can bleed into the next backend. (Token + React Query
 * cache are cleared separately by the auth logout that callers run first.)
 */

export type OrgBootstrapDeps = {
  loadSelectedOrg: () => Promise<SelectedOrg | null>;
  saveSelectedOrg: (org: SelectedOrg) => Promise<void>;
  /** Reads the persisted auth token (presence ⇒ a pre-existing session). */
  getAuthToken: () => Promise<string | null>;
  /** Org every existing single-tenant user is migrated onto. */
  legacyDefaultOrg: SelectedOrg;
  /** Side-effect: point every backend consumer at this origin. */
  applyOrgRouting: (origin: string) => void;
};

/**
 * Resolve the org to start the app with, applying its routing as a side effect.
 * Returns the selected org, or `null` when the app should gate /connect.
 */
export async function bootstrapOrg(deps: OrgBootstrapDeps): Promise<SelectedOrg | null> {
  let selected = await deps.loadSelectedOrg();
  if (!selected) {
    const existingToken = await deps.getAuthToken();
    if (existingToken) {
      selected = deps.legacyDefaultOrg;
      await deps.saveSelectedOrg(selected);
    }
  }
  if (selected) deps.applyOrgRouting(selected.apiBaseUrl);
  return selected;
}

export type OrgSwitchDeps = {
  clearSelectedOrg: () => Promise<void>;
  /** Side-effect: drop the runtime origin + cached feature flags. */
  resetOrgRouting: () => void;
};

/**
 * Forget the current org and reset routing back to the default. Callers MUST
 * log out FIRST (so the logout request hits the CURRENT backend) before calling
 * this, then route to /connect.
 */
export async function performSwitchOrg(deps: OrgSwitchDeps): Promise<void> {
  await deps.clearSelectedOrg();
  deps.resetOrgRouting();
}

export type SwitchOrgFlowDeps = {
  /** Auth logout: clears the session token AND the React Query cache. */
  logout: () => Promise<void>;
  /** Forgets the org + resets backend routing (see performSwitchOrg). */
  switchOrg: () => Promise<void>;
  /** Routes back to the org-connect screen once the switch is done. */
  navigateToConnect: () => void;
};

/**
 * The native "Switch organization" user flow.
 *
 * Order matters for cross-customer safety: log out FIRST so the logout request
 * hits the CURRENT backend and the token + React Query cache are cleared while
 * the old origin is still applied; THEN forget the org and reset routing; THEN
 * navigate to /connect. Logout is best-effort — a failed network logout must
 * not strand the user on the old backend, so we still reset routing.
 */
export async function runSwitchOrgFlow(deps: SwitchOrgFlowDeps): Promise<void> {
  try {
    await deps.logout();
  } catch {
    // Best effort — proceed to reset routing even if the logout request fails.
  }
  await deps.switchOrg();
  deps.navigateToConnect();
}

/** Shown when an org resolution throws without a user-facing message. */
export const CONNECT_ORG_FALLBACK_ERROR =
  "Couldn't connect to that organization. Try again.";

export type ConnectOrgFlowDeps = {
  /** Resolve + persist + apply an org code. Throws a user-facing Error. */
  selectOrg: (code: string) => Promise<unknown>;
  /** Routes on to sign-in once the org is connected. */
  navigateToLogin: () => void;
  /** Drives the busy spinner / disabled state. */
  setBusy: (busy: boolean) => void;
  /** Surfaces the user-facing error (or clears it with null). */
  setError: (message: string | null) => void;
};

/**
 * The pre-login "Connect organization" submit flow, lifted out of the connect
 * screen so it can be unit-tested without rendering the React tree.
 *
 * It trims the code, resolves + applies the org, and routes on to /login on
 * success. On failure it surfaces the thrown Error's user-facing message (or a
 * generic fallback) and crucially does NOT navigate — a bad org code must leave
 * the user on /connect with a clear error, never strand them on a half-applied
 * backend. The busy flag is always cleared so the form stays usable.
 *
 * The component keeps its own reentrancy guard (it must read React `busy`
 * state) and passes the already-resolved raw code in.
 */
export async function runConnectOrgFlow(
  rawCode: string,
  deps: ConnectOrgFlowDeps,
): Promise<void> {
  const trimmed = rawCode.trim();
  if (!trimmed) return;
  deps.setBusy(true);
  deps.setError(null);
  try {
    await deps.selectOrg(trimmed);
    deps.navigateToLogin();
  } catch (e: any) {
    deps.setError(e?.message || CONNECT_ORG_FALLBACK_ERROR);
  } finally {
    deps.setBusy(false);
  }
}

export type SwitchToCodeFlowDeps = {
  /**
   * Atomic teardown of the CURRENT org: logs out (clearing the session token +
   * React Query cache against the current backend), forgets the org, and resets
   * routing back to the default. See OrgContext.switchOrg / performSwitchOrg.
   */
  switchOrg: () => Promise<void>;
  /** Resolve + persist + apply the NEW org code. Throws a user-facing Error. */
  selectOrg: (code: string) => Promise<unknown>;
  /** Routes on to sign-in once the new org is connected. */
  navigateToLogin: () => void;
  /** Drives the busy spinner / disabled state. */
  setBusy: (busy: boolean) => void;
  /** Surfaces the user-facing error (or clears it with null). */
  setError: (message: string | null) => void;
};

/**
 * The "switch to a DIFFERENT org via an invite link / QR while already
 * connected" flow, lifted out of the connect screen so it can be unit-tested
 * without rendering the React tree.
 *
 * Order matters for cross-customer safety: tear down the CURRENT org FIRST
 * (switchOrg logs out against the current backend and clears the session +
 * query cache + routing while the old origin is still applied), THEN resolve +
 * apply the NEW org, THEN route on to sign-in. If resolving the new org fails
 * the user is left signed out on /connect with the error shown — never on a
 * half-applied backend and never with the old tenant's session still live.
 */
export async function runSwitchToCodeFlow(
  rawCode: string,
  deps: SwitchToCodeFlowDeps,
): Promise<void> {
  const trimmed = rawCode.trim();
  if (!trimmed) return;
  deps.setBusy(true);
  deps.setError(null);
  try {
    await deps.switchOrg();
    await deps.selectOrg(trimmed);
    deps.navigateToLogin();
  } catch (e: any) {
    deps.setError(e?.message || CONNECT_ORG_FALLBACK_ERROR);
  } finally {
    deps.setBusy(false);
  }
}
