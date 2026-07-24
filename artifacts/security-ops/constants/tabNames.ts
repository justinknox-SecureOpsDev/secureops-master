/**
 * Canonical nav-bar tab titles for the employee and admin shells.
 *
 * Every user-facing string that names a navigation tab MUST reference one of
 * these constants — never an inline literal. The test in
 * constants/__tests__/tabNames.test.ts verifies that:
 *   1. ALL_NAV_TAB_TITLES stays in sync with the `title:` props in
 *      app/(employee)/_layout.tsx.
 *   2. ALL_ADMIN_NAV_TAB_TITLES stays in sync with the `title:` props in
 *      app/(admin)/_layout.tsx.
 *   3. Every string exported from constants/userCopy.ts that says "X tab"
 *      uses a name present in this file.
 *
 * To rename a tab: change the constant value here → TypeScript compile errors
 * point to every consumer that needs updating → the test catches any copy
 * string that still uses the old name.
 */

// ── Employee shell tabs ───────────────────────────────────────────────────────

export const TAB_HOME = "Home" as const;
export const TAB_MY_WORK = "My Work" as const;
export const TAB_INCIDENTS = "Incidents" as const;
export const TAB_CHAT = "Chat" as const;
export const TAB_PROFILE = "Profile" as const;
export const TAB_MORE = "More" as const;

/**
 * All nav-bar tab titles for the employee shell. Kept in sync with the
 * Tabs.Screen `title` props in app/(employee)/_layout.tsx by the tabNames
 * test suite.
 *
 * Add or remove entries here whenever the layout changes — the test will fail
 * until both sides agree.
 */
export const ALL_NAV_TAB_TITLES: ReadonlySet<string> = new Set([
  TAB_HOME,
  TAB_MY_WORK,
  TAB_INCIDENTS,
  TAB_CHAT,
  TAB_PROFILE,
  TAB_MORE,
]);

/**
 * Labels for the two segment buttons inside the My Work screen (my-work.tsx).
 * These are NOT nav-bar tabs — they live inside the My Work tab as sub-tabs.
 * Copy strings that reference them must use these constants too so a rename
 * is caught by the compiler.
 */
export const MY_WORK_SUBTAB_SHIFTS = "My Shifts" as const;
export const MY_WORK_SUBTAB_CLOCK = "Clock In/Out" as const;

// ── Admin shell tabs ──────────────────────────────────────────────────────────
// These appear in app/(admin)/_layout.tsx and are used by push notification
// body strings and admin-portal copy that direct admins to a specific tab.

export const TAB_ADMIN_OVERVIEW = "Overview" as const;
export const TAB_ADMIN_PERSONNEL = "Personnel" as const;
export const TAB_ADMIN_SHIFTS = "Shifts" as const;
export const TAB_ADMIN_APPROVALS = "Approvals" as const;
export const TAB_ADMIN_LIVE_MAP = "Live Map" as const;
export const TAB_ADMIN_INCIDENTS = "Incidents" as const;
export const TAB_ADMIN_CHAT = "Chat" as const;
export const TAB_ADMIN_RADIO = "Radio" as const;
export const TAB_ADMIN_CLOCK = "Clock" as const;
export const TAB_ADMIN_PROFILE = "Profile" as const;

/**
 * All nav-bar tab titles for the admin shell. Kept in sync with the
 * Tabs.Screen `title` props on visible (non-href-null) screens in
 * app/(admin)/_layout.tsx by the tabNames test suite.
 *
 * Add or remove entries here whenever the admin layout changes — the test
 * will fail until both sides agree.
 */
export const ALL_ADMIN_NAV_TAB_TITLES: ReadonlySet<string> = new Set([
  TAB_ADMIN_OVERVIEW,
  TAB_ADMIN_PERSONNEL,
  TAB_ADMIN_SHIFTS,
  TAB_ADMIN_APPROVALS,
  TAB_ADMIN_LIVE_MAP,
  TAB_ADMIN_INCIDENTS,
  TAB_ADMIN_CHAT,
  TAB_ADMIN_RADIO,
  TAB_ADMIN_CLOCK,
  TAB_ADMIN_PROFILE,
]);
