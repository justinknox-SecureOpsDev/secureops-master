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

export type OrgRefreshDeps = {
  /** Resolve a code via the central directory. Throws on any failure. */
  resolveOrgCode: (code: string) => Promise<SelectedOrg>;
  /** Re-read what is CURRENTLY persisted (race guard — see below). */
  loadSelectedOrg: () => Promise<SelectedOrg | null>;
  saveSelectedOrg: (org: SelectedOrg) => Promise<void>;
  /** Side-effect: point every backend consumer at this origin. */
  applyOrgRouting: (origin: string) => void;
  /** Notified only when the stored org actually changed (e.g. update React state). */
  onUpdated?: (org: SelectedOrg) => void;
};

/**
 * Background self-heal for stale backend origins.
 *
 * Devices persist the org's backend ORIGIN at connect time; if a customer's
 * deployment later moves to a new domain, those devices keep talking to the
 * old origin forever (observed in production: password-reset requests from
 * mobile never reached the current backend). On every launch we quietly
 * re-resolve the STORED code against the directory and, only when the
 * directory reports a different origin, persist + apply the new one.
 *
 * Failure policy is strictly conservative:
 *   - no stored org or blank code → no-op (nothing to refresh);
 *   - directory unreachable / unknown code / bad response → keep the stored
 *     value untouched (a flaky network must never disconnect a working app);
 *   - same origin → no-op (no churn, no state updates).
 *
 * Returns the updated org when a change was applied, else null. Callers run
 * this fire-and-forget AFTER bootstrapOrg — it must never gate the UI.
 */
export async function refreshSelectedOrg(
  current: SelectedOrg | null,
  deps: OrgRefreshDeps,
): Promise<SelectedOrg | null> {
  if (!current || !current.code.trim()) return null;
  let resolved: SelectedOrg;
  try {
    resolved = await deps.resolveOrgCode(current.code);
  } catch {
    return null;
  }
  if (resolved.apiBaseUrl === current.apiBaseUrl) return null;
  // RACE GUARD: the directory round-trip can be slow; the user may have run
  // switchOrg (stored org cleared) or selectOrg (different org persisted) in
  // the meantime. Re-read storage and abort unless it still holds EXACTLY the
  // snapshot we started from — otherwise a stale refresh would silently route
  // the app back to the previous tenant's backend (cross-tenant invariant).
  const stillStored = await deps.loadSelectedOrg();
  if (
    !stillStored ||
    stillStored.code !== current.code ||
    stillStored.apiBaseUrl !== current.apiBaseUrl
  ) {
    return null;
  }
  // Persist FIRST: if the save fails we leave routing on the stored origin so
  // storage and live routing can never disagree; the next launch retries.
  await deps.saveSelectedOrg(resolved);
  deps.applyOrgRouting(resolved.apiBaseUrl);
  deps.onUpdated?.(resolved);
  return resolved;
}

export type SelectOrgDeps = {
  saveSelectedOrg: (org: SelectedOrg) => Promise<void>;
  /** Side-effect: point every backend consumer at this origin. */
  applyOrgRouting: (origin: string) => void;
  /**
   * Eagerly fetch + cache the org's brand (see hooks/useFeatures). MUST be
   * awaited before this flow resolves so the login screen the caller navigates
   * to renders in tenant colors immediately — no flash of the default look.
   * Failures are swallowed here: a brand fetch error must never block connect.
   */
  prefetchBrand: () => Promise<void>;
};

/**
 * Apply an ALREADY-RESOLVED org: persist it, route every backend consumer at
 * it, and eagerly warm the brand cache BEFORE resolving. Shared by
 * OrgContext.selectOrg (directory-resolved code) and selectDefaultOrg (the
 * App-Review "Try Demo" path, which bypasses the directory).
 *
 * Ordering is the invariant under test in selectOrgBrandPrefetch.test.ts:
 * routing must be applied BEFORE prefetchBrand (so the fetch hits the new
 * backend), and prefetchBrand must be AWAITED before this returns (so brand is
 * cached before the caller navigates to login).
 */
export async function applySelectedOrg(
  org: SelectedOrg,
  deps: SelectOrgDeps,
): Promise<SelectedOrg> {
  await deps.saveSelectedOrg(org);
  deps.applyOrgRouting(org.apiBaseUrl);
  await deps.prefetchBrand().catch(() => {});
  return org;
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
