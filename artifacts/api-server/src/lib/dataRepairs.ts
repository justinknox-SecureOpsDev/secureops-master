import { and, eq, isNull } from "drizzle-orm";
import { db, shiftsTable, siteRatesTable } from "@workspace/db";
import { logger } from "./logger";

// ── One-time, idempotent production data repair ─────────────────────────────
// A single shift ("InSo Social", site InSo Social Club) was saved with its end
// DATE set a week past its start — 2026-06-07 01:00Z → 2026-06-14 07:00Z, i.e.
// 174 hours instead of the intended ~6-hour overnight window. Two officers were
// "accepted" on it, so the overlap guard treated them as on-duty all week and
// silently rejected every overlapping assignment ("already assigned another
// shift") and blocked their self clock-in, while the shift itself stayed hidden
// from day/upcoming views.
//
// This corrects that one row back to a 6-hour window (matching the rest of the
// InSo overnight series). It is GUARDED on the exact wrong end value, so:
//   • it touches nothing once corrected (re-runs match 0 rows),
//   • it no-ops in dev / any DB that doesn't have this row,
//   • it never overwrites a value an admin has since fixed by hand.
// Safe to leave in place; safe to delete once it has run in production.
const BROKEN_SHIFT_ID = "47f95936-f917-48d9-9537-3ced439c06f0";
const WRONG_END_TIME = new Date("2026-06-14T07:00:00.000Z");
const CORRECT_END_TIME = new Date("2026-06-07T07:00:00.000Z");

// ── One-time, idempotent label backfill for site_rates ──────────────────────
// The unique constraint on site_rates changed from (siteId, licenseLevel) to
// (siteId, licenseLevel, label).  Any rows that still carry a NULL label must
// be assigned a concrete value before the new constraint is enforced by a
// `db push`, otherwise the uniqueness guarantee cannot be applied (SQL treats
// NULL != NULL, so two null-label rows per level would slip past the index).
// Assigning "Standard" to legacy rows is safe because:
//   • The old constraint allowed at most ONE row per (siteId, level), so there
//     is no collision risk when we backfill — we are writing different label
//     values to different rows.
//   • "Standard" is a neutral sentinel that admins can rename at any time via
//     the rate-card edit form.
// Safe to leave in place once run; the WHERE label IS NULL guard is a no-op
// once all rows are labelled.
export async function backfillSiteRateLabels(): Promise<void> {
  const fixed = await db
    .update(siteRatesTable)
    .set({ label: "Standard" })
    .where(isNull(siteRatesTable.label))
    .returning({ id: siteRatesTable.id });
  if (fixed.length > 0) {
    logger.info({ count: fixed.length }, "Backfilled site_rates.label = 'Standard' for legacy null-label rows");
  }
}

export async function repairInsoSocialShiftEndTime(): Promise<void> {
  const fixed = await db
    .update(shiftsTable)
    .set({ endTime: CORRECT_END_TIME })
    .where(and(eq(shiftsTable.id, BROKEN_SHIFT_ID), eq(shiftsTable.endTime, WRONG_END_TIME)))
    .returning({ id: shiftsTable.id });
  if (fixed.length > 0) {
    logger.info({ shiftId: BROKEN_SHIFT_ID }, "Repaired malformed shift end time (174h -> 6h window)");
  }
}
