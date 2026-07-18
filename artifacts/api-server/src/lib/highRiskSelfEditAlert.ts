import { db, highRiskChangeQueueTable } from "@workspace/db";
import type { Logger } from "pino";

/**
 * Fields a self-edit must trigger an out-of-band admin alert for. The
 * employee_changes log captures every field; this set is the much narrower
 * subset where a silent edit could mean fraud, a lost device, or a costly
 * payroll mistake — admins need a push + email the same day, not a weekly
 * audit-log review.
 *
 * niNumber (SSN last 4), rightToWorkStatus and directDepositConsent are now
 * self-editable from the mobile profile, so a change to any of them must reach
 * admins the same day (work-authorization and direct-deposit changes warrant HR
 * re-verification). directDepositSignature stays admin-only but is listed
 * defensively so the alert path is already in place if it ever opens up.
 */
export const HIGH_RISK_SELF_EDIT_FIELDS = new Set<string>([
  "bankAccountName", "bankAccountNumber", "bankBsb",
  "emergencyContactName", "emergencyContactRelationship", "emergencyContactPhone",
  "niNumber",
  "rightToWorkStatus",
  "directDepositConsent",
  "directDepositSignature",
]);

function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Detect which high-risk fields actually changed between `before` and `after`.
 * Returns an empty array if none of the high-risk fields were touched.
 *
 * A missing `before` row (first-ever profile save from the mobile app — the
 * employees-row upsert path in PATCH /me/employee) is treated as an empty
 * baseline so an initial non-empty banking / emergency-contact value still
 * triggers an admin alert. A missing `after` means the write failed and
 * there is nothing to report.
 */
export function diffHighRiskChanges(
  keys: string[],
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!after) return [];
  const beforeSafe = before ?? {};
  return keys.filter((k) => HIGH_RISK_SELF_EDIT_FIELDS.has(k) && norm(beforeSafe[k]) !== norm(after[k]));
}

/**
 * Enqueue a high-risk self-edit for the per-officer admin digest.
 *
 * Designed to be called as fire-and-forget (`void enqueue…(…)`) from
 * profile-save endpoints — failures are logged but never surface to the
 * caller so DB blips can't break a user's profile save.
 *
 * The digest is fanned out by the `high-risk-digest` scheduled job in
 * `lib/scheduledJobs.ts` once the oldest pending row for the officer is
 * at least 15 minutes old. Multiple edits inside that window collapse
 * into a single push + a single email listing every field that changed.
 *
 * Idempotency / dedup at the field level is the caller's responsibility
 * (the change-log gate already filters no-op writes). Within a single
 * digest window the job de-duplicates repeated edits of the same field
 * down to one row before sending, so flipping bank-account-number twice
 * still produces one digest entry.
 */
export async function enqueueHighRiskSelfEdit(opts: {
  employeeUserId: string;
  changedFields: string[];
  log: Logger;
}): Promise<void> {
  const { employeeUserId, changedFields, log } = opts;
  if (changedFields.length === 0) return;
  try {
    await db
      .insert(highRiskChangeQueueTable)
      .values(changedFields.map((field) => ({ employeeUserId, field })));
  } catch (err) {
    log.warn({ err, employeeUserId, fields: changedFields }, "failed to enqueue high-risk self-edit alert");
  }
}
