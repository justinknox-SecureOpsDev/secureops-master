/**
 * Single source of truth for the license-expiry reminder tier schedule.
 *
 * `sendLicenseExpiryReminders` (artifacts/api-server/src/lib/scheduledJobs.ts)
 * sends a reminder whenever a license's expiry falls inside each of these
 * day-count windows, largest first, and stamps `licenses.last_reminder_tier`
 * so the same tier is never sent twice for one expiry.
 *
 * The admin portal's License Renewals page describes this same schedule to
 * admins. Import `LICENSE_REMINDER_TIER_DAYS` (or the formatted helper)
 * there instead of hand-writing the day counts, so the copy can never drift
 * from what the job actually sends again.
 */
export const LICENSE_REMINDER_TIER_DAYS = [60, 30, 14, 7] as const;

/**
 * Same tiered-reminder pattern as `LICENSE_REMINDER_TIER_DAYS`, applied to
 * subcontractor COI (certificate of insurance) expiries.
 *
 * `sendCoiExpiryReminders` (artifacts/api-server/src/lib/scheduledJobs.ts)
 * sends a reminder whenever a COI's expiry falls inside each of these
 * day-count windows, largest first, and stamps
 * `subcontractor_cois.last_reminder_tier` so the same tier is never sent
 * twice for one expiry. Any admin-portal copy describing this cadence
 * should import this constant (or the formatted helper) instead of
 * hand-writing the day counts.
 */
export const COI_REMINDER_TIER_DAYS = [60, 30, 14, 7] as const;

/**
 * Same tiered-reminder pattern as `LICENSE_REMINDER_TIER_DAYS`, applied to
 * training-certification expiries.
 *
 * `sendTrainingExpiryReminders` (artifacts/api-server/src/lib/scheduledJobs.ts)
 * sends a reminder whenever a certification's expiry falls inside each of
 * these day-count windows, largest first, and stamps
 * `training_certifications.last_reminder_tier` so the same tier is never
 * sent twice for one expiry. Any admin-portal copy describing this cadence
 * should import this constant (or the formatted helper) instead of
 * hand-writing the day counts.
 */
export const TRAINING_REMINDER_TIER_DAYS = [60, 30, 14, 7] as const;

/**
 * Human-readable list of the tiers, e.g. "60, 30, 14, and 7 days".
 */
export function formatReminderTierDaysList(
  tiers: readonly number[] = LICENSE_REMINDER_TIER_DAYS,
): string {
  if (tiers.length === 0) return "";
  if (tiers.length === 1) return `${tiers[0]} days`;
  const head = tiers.slice(0, -1).join(", ");
  const last = tiers[tiers.length - 1];
  return `${head}, and ${last} days`;
}
