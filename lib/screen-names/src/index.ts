/**
 * Canonical nav-bar tab titles and sub-tab labels for the SecureOps mobile app.
 *
 * This is the single source of truth for screen/tab names that may appear in
 * push notification body strings, user-facing copy, and mobile navigation.
 *
 * Consumers:
 *   - artifacts/security-ops/constants/tabNames.ts  — re-exports these for the
 *     mobile app; the mobile test suite keeps ALL_NAV_TAB_TITLES and
 *     ALL_ADMIN_NAV_TAB_TITLES in sync with the actual Tabs.Screen title props.
 *   - artifacts/api-server/src/__tests__/pushScreenNames.test.ts — guards push
 *     notification body strings against stale screen names.
 *
 * To rename a tab: update the constant value here → TypeScript compile errors
 * surface every consumer → the test suites catch any remaining copy strings
 * that still use the old name.
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

// The admin shell mirrors the employee/site-manager shell: six visible tabs
// (Home, My Work, Incidents, Chat, Profile, More) with all management tools
// reached through the More → Management screen. The management screens keep
// their own titles below — they still render as native headers and are
// referenced by push-notification copy — but they are no longer nav-bar tabs.
export const TAB_ADMIN_HOME = "Home" as const;
export const TAB_ADMIN_MY_WORK = "My Work" as const;
export const TAB_ADMIN_PERSONNEL = "Personnel" as const;
export const TAB_ADMIN_SHIFTS = "Shifts" as const;
export const TAB_ADMIN_APPROVALS = "Approvals" as const;
export const TAB_ADMIN_LIVE_MAP = "Live Map" as const;
export const TAB_ADMIN_INCIDENTS = "Incidents" as const;
export const TAB_ADMIN_CHAT = "Chat" as const;
export const TAB_ADMIN_RADIO = "Radio" as const;
export const TAB_ADMIN_PROFILE = "Profile" as const;
export const TAB_ADMIN_MORE = "More" as const;

/**
 * All nav-bar tab titles for the admin shell. Kept in sync with the
 * Tabs.Screen `title` props on visible (non-href-null) screens in
 * app/(admin)/_layout.tsx by the tabNames test suite.
 *
 * Add or remove entries here whenever the admin layout changes — the test
 * will fail until both sides agree.
 */
export const ALL_ADMIN_NAV_TAB_TITLES: ReadonlySet<string> = new Set([
  TAB_ADMIN_HOME,
  TAB_ADMIN_MY_WORK,
  TAB_ADMIN_PERSONNEL,
  TAB_ADMIN_SHIFTS,
  TAB_ADMIN_APPROVALS,
  TAB_ADMIN_LIVE_MAP,
  TAB_ADMIN_INCIDENTS,
  TAB_ADMIN_CHAT,
  TAB_ADMIN_RADIO,
  TAB_ADMIN_PROFILE,
  TAB_ADMIN_MORE,
]);

/**
 * The union of all screen/tab names that may appear in push notification body
 * strings. Combines every employee tab, admin tab, and My Work sub-tab so the
 * API server test suite can import this directly instead of constructing it
 * locally — ensuring a tab rename causes a compile error in the mobile app AND
 * a failing test in the API server without any manual synchronisation.
 */
export const ALLOWED_PUSH_SCREEN_NAMES: ReadonlySet<string> = new Set([
  ...ALL_NAV_TAB_TITLES,
  ...ALL_ADMIN_NAV_TAB_TITLES,
  MY_WORK_SUBTAB_SHIFTS,
]);
