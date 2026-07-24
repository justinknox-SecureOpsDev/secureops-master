/**
 * Canonical nav-bar tab titles for the employee and admin shells.
 *
 * The constants are defined in @workspace/screen-names (lib/screen-names) so
 * the API server test suite can also import them — ensuring both push
 * notification bodies and mobile copy strings are checked against the same
 * source of truth.
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
 * To rename a tab: change the constant value in lib/screen-names/src/index.ts
 * → TypeScript compile errors point to every consumer that needs updating →
 * the test catches any copy string that still uses the old name.
 */

export {
  TAB_HOME,
  TAB_MY_WORK,
  TAB_INCIDENTS,
  TAB_CHAT,
  TAB_PROFILE,
  TAB_MORE,
  ALL_NAV_TAB_TITLES,
  MY_WORK_SUBTAB_SHIFTS,
  MY_WORK_SUBTAB_CLOCK,
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
  ALL_ADMIN_NAV_TAB_TITLES,
  ALLOWED_PUSH_SCREEN_NAMES,
} from "@workspace/screen-names";
