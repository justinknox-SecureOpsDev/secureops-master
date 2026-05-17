import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { Logger } from "pino";
import { sendPushToUsers } from "./push";
import { sendEmail, renderHighRiskProfileChangeEmail } from "./email";
import { CHANGE_FIELD_LABELS } from "./employeeChangeLog";

/**
 * Fields a self-edit must trigger an out-of-band admin alert for. The
 * employee_changes log captures every field; this set is the much narrower
 * subset where a silent edit could mean fraud, a lost device, or a costly
 * payroll mistake — admins need a push + email the same day, not a weekly
 * audit-log review.
 *
 * Includes admin-only fields (niNumber, directDepositSignature) defensively:
 * if a future change opens them to self-edit, the alert path is already in
 * place.
 */
export const HIGH_RISK_SELF_EDIT_FIELDS = new Set<string>([
  "bankAccountName", "bankAccountNumber", "bankBsb",
  "emergencyContactName", "emergencyContactRelationship", "emergencyContactPhone",
  "niNumber",
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
 * Fan-out a push + templated email to every active admin for a self-edit
 * touching one or more high-risk fields. Designed to be called as
 * fire-and-forget (`void notify…(…)`) — failures are logged but never
 * surface to the caller, so SMTP / Expo flakiness can't break a user's
 * profile save.
 *
 * Idempotency / dedup is the caller's responsibility (the change-log gate
 * already filters out no-op writes).
 */
export async function notifyAdminsOfHighRiskSelfEdit(opts: {
  employeeUserId: string;
  officerName: string;
  officerEmail: string;
  changedFields: string[];
  log: Logger;
}): Promise<void> {
  const { employeeUserId, officerName, officerEmail, changedFields, log } = opts;
  if (changedFields.length === 0) return;
  try {
    const labels = changedFields.map((k) => CHANGE_FIELD_LABELS[k] ?? k);
    const whenIso = new Date().toISOString();
    const admins = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
    if (admins.length === 0) return;

    await sendPushToUsers(
      admins.map((a) => a.id),
      {
        title: "Officer self-edit alert",
        body: `${officerName} updated ${labels.length === 1 ? labels[0] : `${labels.length} sensitive fields`}. Tap to review.`,
        data: { type: "high_risk_profile_change", employeeUserId, fields: changedFields },
      },
    );

    const base = process.env.APP_BASE_URL
      || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "");
    const reviewUrl = base ? `${base}/admin-portal/personnel/${employeeUserId}/changes` : undefined;
    const tmpl = renderHighRiskProfileChangeEmail({
      officerName,
      officerEmail,
      fieldLabels: labels,
      whenIso,
      reviewUrl,
    });
    await Promise.all(
      admins
        .filter((a) => !!a.email)
        .map((a) => sendEmail({ to: a.email!, subject: tmpl.subject, text: tmpl.text, html: tmpl.html })),
    );
  } catch (err) {
    log.warn({ err, employeeUserId, fields: changedFields }, "high-risk self-edit alert dispatch failed");
  }
}
