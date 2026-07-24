/**
 * User-facing copy strings that reference navigation tab or sub-tab names.
 *
 * Import from here instead of writing inline literals in screens. Because
 * each string is built from a tabNames constant, TypeScript will surface a
 * compile error if the underlying tab is renamed without updating the copy.
 * The tabNames test suite additionally asserts that every "X tab" pattern in
 * these strings resolves to a known tab name.
 *
 * Admin-portal and API-server copies that reference mobile tab names must
 * define a LOCAL constant mirroring the relevant tabNames value (those
 * packages cannot import from security-ops). The tabNames test reads those
 * source files directly and validates any "X tab" phrases against the same
 * KNOWN_TAB_PREFIXES set to catch stale references at test time.
 */

import { TAB_MY_WORK, TAB_CHAT, MY_WORK_SUBTAB_SHIFTS, TAB_ADMIN_LIVE_MAP } from "./tabNames";

/** Shown when an officer tries to clock in from the Shifts list while already on duty. */
export const COPY_ALREADY_CLOCKED_IN =
  `You're already clocked in. Clock out first from the ${TAB_MY_WORK} tab.`;

/**
 * Shown in a success notification after an officer clocks in directly from the
 * Shifts list (quick-clock-in path).
 */
export const COPY_CLOCKED_IN_SUCCESS = (shiftTitle: string): string =>
  `You're on duty for ${shiftTitle}. Open the ${TAB_MY_WORK} tab to clock out when finished.`;

/**
 * Inline status banner on a shift card when the officer is currently clocked
 * in to that shift.
 */
export const COPY_ON_DUTY_BANNER =
  `On duty — clock out from the ${TAB_MY_WORK} tab`;

/**
 * Empty-state hint shown in the Clock In/Out sub-tab when no clocked-in shifts
 * are available and the officer has no upcoming shifts within the clock-in
 * window. Directs them to the My Shifts sub-tab to reserve one first.
 */
export const COPY_NO_SHIFTS_HINT =
  `No shifts to clock into right now. You can clock in from 30 minutes before a reserved shift starts — reserve shifts in the ${MY_WORK_SUBTAB_SHIFTS} sub-tab.`;

/**
 * Dispatch tour step body explaining where officers will see a broadcast
 * message after it is sent from the admin portal. Referenced by the dispatch
 * tour in admin-portal/src/pages/Dispatch.tsx — that file cannot import this
 * constant directly (cross-package), so it defines a local mirror; this
 * export is the canonical wording validated by the tabNames test suite.
 */
export const COPY_DISPATCH_BROADCAST_HINT =
  `Pick a channel (📣 announcements goes org-wide), preview the thread if you want context, then send. Officers see it instantly in the ${TAB_CHAT} tab and via push notification.`;

/**
 * Suffix appended to admin geofence-breach SMS messages directing the
 * recipient to the admin mobile Live Map tab. Mirrored in
 * artifacts/api-server/src/lib/push.ts (SMS_GEOFENCE_MAP_PROMPT) for use
 * by the API server — that file defines its own constant so it does not
 * depend on the security-ops package.
 */
export const COPY_GEOFENCE_SMS_MAP_CHECK =
  `Check ${TAB_ADMIN_LIVE_MAP}.`;
