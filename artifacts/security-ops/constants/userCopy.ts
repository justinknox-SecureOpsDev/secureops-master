/**
 * User-facing copy strings that reference navigation tab or sub-tab names.
 *
 * Import from here instead of writing inline literals in screens. Because
 * each string is built from a tabNames constant, TypeScript will surface a
 * compile error if the underlying tab is renamed without updating the copy.
 * The tabNames test suite additionally asserts that every "X tab" pattern in
 * these strings resolves to a known tab name.
 */

import { TAB_MY_WORK, MY_WORK_SUBTAB_SHIFTS } from "./tabNames";

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
