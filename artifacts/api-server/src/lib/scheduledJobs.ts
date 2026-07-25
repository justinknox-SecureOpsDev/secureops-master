import { lt, eq, and, or, isNull, gt, gte, lte, ne, sql, inArray } from "drizzle-orm";
import {
  db,
  revokedTokensTable,
  applicationDraftsTable,
  licensesTable,
  trainingCertificationsTable,
  usersTable,
  shiftsTable,
  shiftAssignmentsTable,
  sitesTable,
  timeEntriesTable,
  payrollEntriesTable,
  patrolScansTable,
  highRiskChangeQueueTable,
  locationPingsTable,
  subcontractorCoisTable,
  subcontractorsTable,
  schedulerSyncCursorsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { sendEmail, renderLicenseExpiryEmail, renderTrainingExpiryEmail, renderHighRiskProfileChangeEmail, renderCoiExpiryEmail } from "./email";
import { brand } from "./brandConfig";
import { sendPushToUsers } from "./push";
import { sendSmsToUsers } from "./sms";
import { CHANGE_FIELD_LABELS } from "./employeeChangeLog";
import { lockEndedWeekInvoices, weekStartIsoUtc } from "./invoiceSync";
import { isSchedulerConfigured, fetchSchedulerDelta } from "./schedulerSync";
import { getSiteManagerUserIds } from "./siteManagerAuthz";
import { businessTimeZone } from "./businessTime";

/**
 * Coalescing window for the high-risk self-edit digest. Edits inside this
 * window collapse into a single push + email per officer. 15 minutes is
 * short enough to keep same-day visibility (admins still see the alert
 * well before the next pay run) while cutting per-keystroke fan-out on
 * larger rosters.
 */
const HIGH_RISK_DIGEST_WINDOW_MS = 15 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

// Auto clock-out: how long past a shift's scheduled end an officer can
// stay clocked in before we close their entry (unless still on site).
const AUTO_CLOCKOUT_GRACE_MS = 10 * MIN_MS;
// How recent a location ping must be for an `inside` geofence reading to
// count as "currently on site". A stale `inside` (phone stopped pinging)
// must NOT veto auto clock-out — that's the case this job exists to fix.
const GEOFENCE_FRESH_MS = 15 * MIN_MS;

/**
 * Background maintenance jobs:
 *   1. Cleanup expired revoked-token rows (hourly).
 *   2. License expiry reminders — tiered emails + push at 60 / 30 / 14 / 7 days
 *      before expiry. Runs hourly but is idempotent: it persists
 *      `licenses.last_reminder_tier` AND `last_reminder_for_expiry` so
 *      a license is never reminded twice for the same tier on the
 *      same expiry, while a renewed license (different expiry) is
 *      treated as a clean slate and gets the full 60/30/14/7 cycle.
 *   3. Pre-shift reminders — push to assigned officers ~2 hours and
 *      ~30 minutes before shift start. Runs every 5 minutes; idempotent
 *      via `shift_assignments.reminder_2h_sent_at` / `reminder_30m_sent_at`,
 *      and uses an atomic UPDATE … RETURNING claim so two overlapping
 *      ticks never double-send the same reminder.
 *
 * Concurrency:
 *   - Each job is wrapped with an in-process `running` flag — if a tick
 *     fires while the previous run is still in flight, the new tick
 *     returns immediately. This prevents single-instance overlap.
 *   - License + shift reminder writes use UPDATE … WHERE … RETURNING so
 *     even if two app instances ran the same job, only one would
 *     successfully claim each row.
 *
 * All jobs swallow errors (logged) so a transient DB issue cannot crash
 * the loop. They are self-throttling — each job's tick is a no-op if
 * there is nothing to do.
 */
export async function cleanupExpiredRevokedTokens(): Promise<void> {
  try {
    const now = new Date();
    const result = await db
      .delete(revokedTokensTable)
      .where(lt(revokedTokensTable.expiresAt, now));
    const removed = (result as { rowCount?: number | null }).rowCount ?? 0;
    if (removed > 0) {
      logger.info({ removed }, "Cleaned up expired revoked tokens");
    }
  } catch (err) {
    logger.error({ err }, "Failed to clean up revoked tokens");
  }
}

export async function sendLicenseExpiryReminders(): Promise<void> {
  try {
    // Tiers run from biggest to smallest so a single sweep advances
    // bookkeeping correctly: a license that has not yet been
    // reminded at the 30-day tier still gets the 30-day notice when
    // it lands inside the 14-day window.
    const tiers = [60, 30, 14, 7];
    const today = new Date();
    const todayDateOnly = today.toISOString().slice(0, 10);

    let totalSent = 0;
    for (const tier of tiers) {
      const cutoff = new Date(today.getTime() + tier * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

        // A license needs THIS tier's reminder when:
        //   - expiry is in the future and within `tier` days, AND
        //   - we have not yet sent this tier (or any smaller one) for
        //     the CURRENT expiry. The "for current expiry" check is
        //     what makes renewals re-arm: if expiryDate changed,
        //     `last_reminder_for_expiry` will not match and the row
        //     is treated as if no reminders had been sent.
        const candidates = await db
          .select({
            id: licensesTable.id,
            employeeId: licensesTable.employeeId,
            type: licensesTable.type,
            licenseNumber: licensesTable.licenseNumber,
            expiryDate: licensesTable.expiryDate,
            firstName: usersTable.firstName,
            email: usersTable.email,
          })
          .from(licensesTable)
          .innerJoin(usersTable, eq(usersTable.id, licensesTable.employeeId))
          .where(
            and(
              gte(licensesTable.expiryDate, todayDateOnly),
              lte(licensesTable.expiryDate, cutoff),
              eq(usersTable.status, "active"),
              or(
                isNull(licensesTable.lastReminderForExpiry),
                ne(licensesTable.lastReminderForExpiry, licensesTable.expiryDate),
                isNull(licensesTable.lastReminderTier),
                gt(licensesTable.lastReminderTier, tier),
              ),
            ),
          );

        for (const lic of candidates) {
          // Atomically claim this (license, tier) pair so a concurrent
          // run on another instance / overlapping tick can never
          // double-send. The WHERE clause repeats the eligibility
          // check; the row is only stamped (and the reminder sent)
          // if we're the first writer.
          const claimed = await db
            .update(licensesTable)
            .set({
              lastReminderTier: tier,
              lastReminderSentAt: new Date(),
              lastReminderForExpiry: lic.expiryDate,
            })
            .where(
              and(
                eq(licensesTable.id, lic.id),
                or(
                  isNull(licensesTable.lastReminderForExpiry),
                  ne(licensesTable.lastReminderForExpiry, lic.expiryDate),
                  isNull(licensesTable.lastReminderTier),
                  gt(licensesTable.lastReminderTier, tier),
                ),
              ),
            )
            .returning({ id: licensesTable.id });

          if (claimed.length === 0) continue; // someone else got it

          const expiry = new Date(lic.expiryDate);
          const daysRemaining = Math.max(
            0,
            Math.ceil((expiry.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
          );
          const tpl = renderLicenseExpiryEmail({
            firstName: lic.firstName ?? "there",
            licenseType: lic.type,
            licenseNumber: lic.licenseNumber,
            expiryDate: lic.expiryDate,
            daysRemaining,
          });

          let emailOk = false;
          let pushOk = false;
          try {
            emailOk = await sendEmail({ to: lic.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
          } catch (err) {
            logger.warn({ err, licenseId: lic.id }, "[license-expiry] email send failed");
          }
          try {
            await sendPushToUsers([lic.employeeId], {
              title: `License expires in ${daysRemaining} days`,
              body: `Your ${lic.type} license expires on ${lic.expiryDate}. Please renew.`,
              data: { type: "license_expiry_reminder", licenseId: lic.id, tier },
            });
            pushOk = true;
          } catch (err) {
            logger.warn({ err, licenseId: lic.id }, "[license-expiry] push send failed");
          }

          // If neither channel succeeded (e.g. SMTP misconfigured AND
          // user has no push token), roll back the bookkeeping so the
          // next tick retries. Push being a no-op on web is a
          // legitimate "can't deliver" — but in that case we still
          // attempted email; if email also failed, we genuinely sent
          // nothing.
          if (!emailOk && !pushOk) {
            await db
              .update(licensesTable)
              .set({ lastReminderTier: null, lastReminderSentAt: null, lastReminderForExpiry: null })
              .where(eq(licensesTable.id, lic.id))
              .catch((err) => logger.warn({ err, licenseId: lic.id }, "[license-expiry] failed to rollback bookkeeping"));
            continue;
          }
          totalSent += 1;
        }
      }
      if (totalSent > 0) {
        logger.info({ totalSent }, "Sent license expiry reminders");
      }
    } catch (err) {
      logger.error({ err }, "[license-expiry] reminder job failed");
    }
}

/**
 * Subcontractor COI (certificate of insurance) expiry reminders. Mirrors the
 * license-expiry job: tiered reminders at 60/30/14/7 days, idempotent via
 * `last_reminder_tier` + `last_reminder_for_expiry` (a renewed COI with a new
 * expiry date re-arms automatically). Unlike licenses, the audience is the
 * ACTIVE ADMIN team (subcontractors are vendors, not portal users) — every
 * due COI fans out a single push + email per admin so HR can chase an updated
 * certificate before coverage lapses.
 */
export async function sendCoiExpiryReminders(): Promise<void> {
  try {
    const tiers = [60, 30, 14, 7];
    const today = new Date();
    const todayDateOnly = today.toISOString().slice(0, 10);

    // Audience is the active admin team. Pre-fetch once; if there are no
    // admins there is nobody to notify, so skip without stamping bookkeeping
    // (a COI must still be remindable once an admin exists).
    const admins = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
    if (admins.length === 0) return;
    const adminIds = admins.map((a) => a.id);
    const adminEmails = admins.map((a) => a.email).filter((e): e is string => !!e);

    let totalSent = 0;
    for (const tier of tiers) {
      const cutoff = new Date(today.getTime() + tier * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const candidates = await db
        .select({
          id: subcontractorCoisTable.id,
          coverageType: subcontractorCoisTable.coverageType,
          insurer: subcontractorCoisTable.insurer,
          policyNumber: subcontractorCoisTable.policyNumber,
          expiryDate: subcontractorCoisTable.expiryDate,
          companyName: subcontractorsTable.companyName,
        })
        .from(subcontractorCoisTable)
        .innerJoin(subcontractorsTable, eq(subcontractorsTable.id, subcontractorCoisTable.subcontractorId))
        .where(
          and(
            gte(subcontractorCoisTable.expiryDate, todayDateOnly),
            lte(subcontractorCoisTable.expiryDate, cutoff),
            eq(subcontractorsTable.status, "active"),
            or(
              isNull(subcontractorCoisTable.lastReminderForExpiry),
              ne(subcontractorCoisTable.lastReminderForExpiry, subcontractorCoisTable.expiryDate),
              isNull(subcontractorCoisTable.lastReminderTier),
              gt(subcontractorCoisTable.lastReminderTier, tier),
            ),
          ),
        );

      for (const coi of candidates) {
        // Atomically claim this (COI, tier) pair so overlapping ticks / a
        // second instance can never double-send.
        const claimed = await db
          .update(subcontractorCoisTable)
          .set({
            lastReminderTier: tier,
            lastReminderSentAt: new Date(),
            lastReminderForExpiry: coi.expiryDate,
          })
          .where(
            and(
              eq(subcontractorCoisTable.id, coi.id),
              or(
                isNull(subcontractorCoisTable.lastReminderForExpiry),
                ne(subcontractorCoisTable.lastReminderForExpiry, coi.expiryDate),
                isNull(subcontractorCoisTable.lastReminderTier),
                gt(subcontractorCoisTable.lastReminderTier, tier),
              ),
            ),
          )
          .returning({ id: subcontractorCoisTable.id });

        if (claimed.length === 0) continue; // someone else got it

        const expiry = new Date(coi.expiryDate);
        const daysRemaining = Math.max(
          0,
          Math.ceil((expiry.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
        );
        const tpl = renderCoiExpiryEmail({
          companyName: coi.companyName,
          coverageType: coi.coverageType,
          policyNumber: coi.policyNumber,
          insurer: coi.insurer,
          expiryDate: coi.expiryDate,
          daysRemaining,
        });

        let emailOk = false;
        let pushOk = false;
        try {
          const results = await Promise.all(
            adminEmails.map((to) => sendEmail({ to, subject: tpl.subject, text: tpl.text, html: tpl.html })),
          );
          emailOk = results.some(Boolean);
        } catch (err) {
          logger.warn({ err, coiId: coi.id }, "[coi-expiry] email send failed");
        }
        try {
          await sendPushToUsers(adminIds, {
            title: `Subcontractor insurance expires in ${daysRemaining} days`,
            body: `${coi.companyName}'s ${coi.coverageType.replace(/_/g, " ")} COI expires on ${coi.expiryDate}. Request an updated certificate.`,
            data: { type: "coi_expiry_reminder", coiId: coi.id, tier },
          });
          pushOk = true;
        } catch (err) {
          logger.warn({ err, coiId: coi.id }, "[coi-expiry] push send failed");
        }

        // Neither channel delivered — roll back bookkeeping so the next tick
        // retries.
        if (!emailOk && !pushOk) {
          await db
            .update(subcontractorCoisTable)
            .set({ lastReminderTier: null, lastReminderSentAt: null, lastReminderForExpiry: null })
            .where(eq(subcontractorCoisTable.id, coi.id))
            .catch((err) => logger.warn({ err, coiId: coi.id }, "[coi-expiry] failed to rollback bookkeeping"));
          continue;
        }
        totalSent += 1;
      }
    }
    if (totalSent > 0) {
      logger.info({ totalSent }, "Sent COI expiry reminders");
    }
  } catch (err) {
    logger.error({ err }, "[coi-expiry] reminder job failed");
  }
}

/**
 * Pre-shift reminders. Push to officers assigned to a shift starting in
 * ~2 hours and ~30 minutes. Skips cancelled or already-started/finished
 * shifts (only `status='upcoming'` is reminded) and assignments not in
 * `accepted` state (declined / pending fills are not reminded). Atomic
 * UPDATE…RETURNING claim on `reminder2hSentAt` / `reminder30mSentAt`
 * makes it idempotent against overlapping ticks AND ensures a shift
 * cancelled mid-tick does not re-fire on the next tick.
 */
export async function sendPreShiftReminders(): Promise<void> {
  try {
    const now = Date.now();
    // Two windows: 2-hour and 30-minute reminders. Use generous
    // ±tick-width windows so a 5-minute job never misses a shift
    // because the cron tick happened slightly before/after the
    // exact target time.
    const windows: Array<{ minOffset: number; maxOffset: number; column: "reminder2hSentAt" | "reminder30mSentAt"; label: string }> = [
      { minOffset: 110 * MIN_MS, maxOffset: 130 * MIN_MS, column: "reminder2hSentAt", label: "2 hours" },
      { minOffset: 25 * MIN_MS, maxOffset: 35 * MIN_MS, column: "reminder30mSentAt", label: "30 minutes" },
    ];

    let totalSent = 0;
    for (const w of windows) {
      const winStart = new Date(now + w.minOffset);
      const winEnd = new Date(now + w.maxOffset);

      const sentColumn = w.column === "reminder2hSentAt"
        ? shiftAssignmentsTable.reminder2hSentAt
        : shiftAssignmentsTable.reminder30mSentAt;

      const rows = await db
        .select({
          assignmentId: shiftAssignmentsTable.id,
          employeeId: shiftAssignmentsTable.employeeId,
          shiftId: shiftsTable.id,
          shiftTitle: shiftsTable.title,
          startTime: shiftsTable.startTime,
          shiftStatus: shiftsTable.status,
          siteName: sitesTable.name,
        })
        .from(shiftAssignmentsTable)
        .innerJoin(shiftsTable, eq(shiftsTable.id, shiftAssignmentsTable.shiftId))
        .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
        .where(
          and(
            eq(shiftAssignmentsTable.status, "accepted"),
            // Cancelled / completed / in-progress shifts must not be
            // reminded. Only shifts the dispatcher has left in the
            // upcoming state earn a pre-shift push.
            eq(shiftsTable.status, "upcoming"),
            gte(shiftsTable.startTime, winStart),
            lte(shiftsTable.startTime, winEnd),
            isNull(sentColumn),
          ),
        );

      for (const r of rows) {
        // Atomically claim this assignment for this window so two
        // overlapping ticks (or two app instances) never double-push
        // the same officer. We only proceed if the claim succeeded.
        const claimed = await db
          .update(shiftAssignmentsTable)
          .set(w.column === "reminder2hSentAt"
            ? { reminder2hSentAt: new Date() }
            : { reminder30mSentAt: new Date() })
          .where(
            and(
              eq(shiftAssignmentsTable.id, r.assignmentId),
              isNull(sentColumn),
            ),
          )
          .returning({ id: shiftAssignmentsTable.id });
        if (claimed.length === 0) continue;

        const startTxt = new Date(r.startTime).toLocaleString("en-US", {
          timeZone: "America/Chicago",
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        const where = r.siteName ? ` @ ${r.siteName}` : "";
        let pushOk = false;
        try {
          await sendPushToUsers([r.employeeId], {
            title: `⏰ Shift starts in ${w.label}`,
            body: `${r.shiftTitle}${where} — ${startTxt}`,
            data: { type: "shift_reminder", shiftId: r.shiftId, when: w.label },
          });
          pushOk = true;
        } catch (err) {
          logger.warn({ err, assignmentId: r.assignmentId }, "[shift-reminder] push send failed");
        }
        if (!pushOk) {
          // Roll back claim so a later tick can retry.
          await db
            .update(shiftAssignmentsTable)
            .set(w.column === "reminder2hSentAt"
              ? { reminder2hSentAt: null }
              : { reminder30mSentAt: null })
            .where(eq(shiftAssignmentsTable.id, r.assignmentId))
            .catch(() => {/* swallow */});
          continue;
        }
        totalSent += 1;
      }
    }
    if (totalSent > 0) {
      logger.info({ totalSent }, "Sent pre-shift reminders");
    }
  } catch (err) {
    logger.error({ err }, "[shift-reminder] job failed");
  }
}

/**
 * Self-healing sweep for payroll rows stranded in `status='processing'`.
 *
 * The PNC pay-run route atomically claims rows to `processing` before the
 * outbound bank call and rolls them back to `pending` on failure. If that
 * rollback UPDATE itself fails (DB hiccup during a PNC outage), the rows
 * would otherwise stay stuck in `processing` forever — never payable, never
 * retryable. This sweep flips any row that has sat in `processing` longer
 * than STUCK_PROCESSING_THRESHOLD_MS back to `pending` and clears the payment
 * bookkeeping, mirroring the route's rollback.
 *
 * Safe by design: a healthy pay-run occupies `processing` only for the
 * duration of one PNC call (seconds), so a 15-minute threshold cannot race a
 * legitimate in-flight submission. Idempotent + race-safe via the WHERE clause
 * (status still processing AND old enough) so overlapping ticks / instances
 * never fight.
 */
const STUCK_PROCESSING_THRESHOLD_MS = 15 * MIN_MS;

export async function recoverStuckProcessingPayrollRows(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS);
    const recovered = await db
      .update(payrollEntriesTable)
      .set({
        status: "pending",
        paidMethod: null,
        paymentReference: null,
        paidBy: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(payrollEntriesTable.status, "processing"),
        lt(payrollEntriesTable.updatedAt, cutoff),
      ))
      .returning({ id: payrollEntriesTable.id });

    if (recovered.length > 0) {
      logger.error(
        { ids: recovered.map((r) => r.id), count: recovered.length },
        "[payroll-stuck-sweep] recovered payroll rows stranded in 'processing' back to 'pending' — a PNC rollback likely failed; admin can retry",
      );
    }
  } catch (err) {
    logger.error({ err }, "[payroll-stuck-sweep] job failed");
  }
}

/**
 * Pending shift-claim approval reminder. Runs hourly.
 *
 * When a shift claim has been sitting in `pending_approval` for more than
 * 2 hours without a decision, push + SMS every active site manager assigned
 * to that shift's site so they know to approve or decline it. Fires once per
 * claim — the atomic UPDATE…RETURNING stamp on `claimReminderSentAt` ensures
 * no double-send even under concurrent ticks or multiple instances.
 */
export async function sendPendingClaimReminders(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 2 * HOUR_MS);

    // Find claims that have been pending_approval for more than 2 hours
    // and have not yet received a reminder.
    const staleClaims = await db
      .select({
        assignmentId: shiftAssignmentsTable.id,
        employeeId: shiftAssignmentsTable.employeeId,
        siteId: shiftsTable.siteId,
        shiftTitle: shiftsTable.title,
        officerFirstName: usersTable.firstName,
        officerLastName: usersTable.lastName,
      })
      .from(shiftAssignmentsTable)
      .innerJoin(shiftsTable, eq(shiftsTable.id, shiftAssignmentsTable.shiftId))
      .innerJoin(usersTable, eq(usersTable.id, shiftAssignmentsTable.employeeId))
      .where(
        and(
          eq(shiftAssignmentsTable.status, "pending_approval"),
          lt(shiftAssignmentsTable.createdAt, cutoff),
          isNull(shiftAssignmentsTable.claimReminderSentAt),
        ),
      );

    if (staleClaims.length === 0) return;

    let totalSent = 0;
    for (const claim of staleClaims) {
      if (!claim.siteId) continue;

      // Atomically claim this assignment so two overlapping ticks / instances
      // can never double-send the reminder for the same claim.
      const claimed = await db
        .update(shiftAssignmentsTable)
        .set({ claimReminderSentAt: new Date() })
        .where(
          and(
            eq(shiftAssignmentsTable.id, claim.assignmentId),
            eq(shiftAssignmentsTable.status, "pending_approval"),
            isNull(shiftAssignmentsTable.claimReminderSentAt),
          ),
        )
        .returning({ id: shiftAssignmentsTable.id });
      if (claimed.length === 0) continue; // another tick/instance got it

      const managerIds = await getSiteManagerUserIds(claim.siteId);
      // Exclude the officer who made the claim in case they somehow also hold
      // a site_manager role (structural guard; getSiteManagerUserIds already
      // filters to role=site_manager so overlap is unlikely but possible).
      const recipientIds = managerIds.filter((id) => id !== claim.employeeId);
      if (recipientIds.length === 0) continue;

      const officerName =
        [claim.officerFirstName, claim.officerLastName].filter(Boolean).join(" ") || "An officer";
      const pushBody = `${officerName} is waiting on your approval for ${claim.shiftTitle} — tap to review.`;
      const smsBody = `SecureOps: Pending Claim — ${officerName} is waiting for approval on shift "${claim.shiftTitle}". Please log in to review.`;

      let pushOk = false;
      try {
        await sendPushToUsers(recipientIds, {
          title: "⏳ Pending Claim",
          body: pushBody,
          data: { type: "pending_claim_reminder", assignmentId: claim.assignmentId },
        });
        pushOk = true;
      } catch (err) {
        logger.warn({ err, assignmentId: claim.assignmentId }, "[pending-claim-reminder] push send failed");
      }

      try {
        await sendSmsToUsers(recipientIds, smsBody);
      } catch (err) {
        logger.warn({ err, assignmentId: claim.assignmentId }, "[pending-claim-reminder] sms send failed");
      }

      if (!pushOk) {
        // Roll back the stamp so the next tick retries (SMS-only is still a
        // partial delivery, but push is the primary channel; roll back to
        // preserve retry semantics).
        await db
          .update(shiftAssignmentsTable)
          .set({ claimReminderSentAt: null })
          .where(eq(shiftAssignmentsTable.id, claim.assignmentId))
          .catch(() => {/* swallow */});
        continue;
      }
      totalSent += 1;
    }

    if (totalSent > 0) {
      logger.info({ totalSent }, "Sent pending shift-claim approval reminders");
    }
  } catch (err) {
    logger.error({ err }, "[pending-claim-reminder] job failed");
  }
}

/**
 * Unconfirmed time-entry reminder. Officers must review + confirm their
 * recorded times after clock-out before an entry enters the admin approval
 * queue. If they close the app without confirming, the entry sits in
 * `awaiting_confirmation` until the next Clock-tab visit — this job nudges
 * them by push (+ SMS if opted in) once the entry has been awaiting for
 * more than an hour.
 *
 * One reminder per entry, ever: the atomic UPDATE…RETURNING stamp on
 * `confirmationReminderSentAt` debounces overlapping ticks and multiple
 * instances. Entries confirmed (or force-cleared by an admin) before the
 * tick are excluded by the `confirmation_status='awaiting_confirmation'`
 * filter; the same predicate in the claim WHERE clause means a confirm
 * racing the tick also suppresses the reminder.
 */
const CONFIRMATION_REMINDER_DELAY_MS = HOUR_MS;

export async function sendUnconfirmedEntryReminders(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - CONFIRMATION_REMINDER_DELAY_MS);

    const stale = await db
      .select({
        entryId: timeEntriesTable.id,
        employeeId: timeEntriesTable.employeeId,
        clockOutTime: timeEntriesTable.clockOutTime,
        siteName: sitesTable.name,
      })
      .from(timeEntriesTable)
      .leftJoin(sitesTable, eq(sitesTable.id, timeEntriesTable.siteId))
      .where(
        and(
          eq(timeEntriesTable.confirmationStatus, "awaiting_confirmation"),
          lt(timeEntriesTable.clockOutTime, cutoff),
          isNull(timeEntriesTable.confirmationReminderSentAt),
        ),
      );

    if (stale.length === 0) return;

    let totalSent = 0;
    for (const entry of stale) {
      // Atomically claim this entry so overlapping ticks / a second instance
      // can never double-send, and a confirm racing the tick suppresses it.
      const claimed = await db
        .update(timeEntriesTable)
        .set({ confirmationReminderSentAt: new Date() })
        .where(
          and(
            eq(timeEntriesTable.id, entry.entryId),
            eq(timeEntriesTable.confirmationStatus, "awaiting_confirmation"),
            isNull(timeEntriesTable.confirmationReminderSentAt),
          ),
        )
        .returning({ id: timeEntriesTable.id });
      if (claimed.length === 0) continue;

      const where = entry.siteName ? ` at ${entry.siteName}` : "";
      const pushBody = `Your shift${where} is waiting on your time confirmation. Open the My Work tab to review and confirm your hours.`;
      const smsBody = `SecureOps: Please confirm your recorded hours for your recent shift${where}. Open the app's My Work tab to review and confirm.`;

      let pushOk = false;
      try {
        await sendPushToUsers([entry.employeeId], {
          title: "⏱️ Confirm your shift times",
          body: pushBody,
          data: { type: "confirm_time_entry_reminder", timeEntryId: entry.entryId },
        });
        pushOk = true;
      } catch (err) {
        logger.warn({ err, timeEntryId: entry.entryId }, "[confirm-entry-reminder] push send failed");
      }

      try {
        await sendSmsToUsers([entry.employeeId], smsBody);
      } catch (err) {
        logger.warn({ err, timeEntryId: entry.entryId }, "[confirm-entry-reminder] sms send failed");
      }

      if (!pushOk) {
        // Roll back the stamp so the next tick retries (push is the primary
        // channel; SMS-only delivery still rolls back to preserve retries).
        await db
          .update(timeEntriesTable)
          .set({ confirmationReminderSentAt: null })
          .where(eq(timeEntriesTable.id, entry.entryId))
          .catch(() => {/* swallow */});
        continue;
      }
      totalSent += 1;
    }

    if (totalSent > 0) {
      logger.info({ totalSent }, "Sent unconfirmed time-entry reminders");
    }
  } catch (err) {
    logger.error({ err }, "[confirm-entry-reminder] job failed");
  }
}

/**
 * Weekly time-entry approval reminder. Runs hourly but self-gates: only
 * fires on Fridays between 17:00 and 19:00 in the business timezone.
 *
 * For each site that has unapproved (pending) time entries for the current
 * Mon–Sun UTC pay week and has not yet received a reminder this week, push +
 * SMS every active site manager at that site. The `sites.te_approval_reminder_week`
 * column stores the UTC-Monday ISO date of the last week a reminder was sent;
 * the job skips sites whose stored key matches the current week, making the
 * reminder idempotent across multiple Friday ticks.
 */
export async function sendWeeklyTimeEntryApprovalReminders(): Promise<void> {
  try {
    const tz = businessTimeZone();
    const now = new Date();

    // Self-gate: only run on Fridays between 17:00 and 19:00 business time.
    const tzParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const weekdayPart = tzParts.find((p) => p.type === "weekday")?.value;
    const hourPart = tzParts.find((p) => p.type === "hour")?.value;
    const hourNum = hourPart !== undefined ? Number(hourPart) : -1;
    if (weekdayPart !== "Fri" || hourNum < 17 || hourNum >= 19) return;

    // Current pay week: Mon 00:00 UTC that starts this week.
    const weekKey = weekStartIsoUtc(now); // "YYYY-MM-DD" of the Monday

    const weekStart = new Date(weekKey + "T00:00:00Z");
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * HOUR_MS);

    // Find distinct siteIds that have pending time entries this week and
    // have not yet received a reminder for this week.
    const pendingSites = await db
      .selectDistinct({ siteId: timeEntriesTable.siteId })
      .from(timeEntriesTable)
      .innerJoin(sitesTable, eq(sitesTable.id, timeEntriesTable.siteId))
      .where(
        and(
          eq(timeEntriesTable.approvalStatus, "pending"),
          gte(timeEntriesTable.clockInTime, weekStart),
          lt(timeEntriesTable.clockInTime, weekEnd),
          sql`${sitesTable.teApprovalReminderWeek} IS DISTINCT FROM ${weekKey}`,
        ),
      );

    if (pendingSites.length === 0) return;

    let totalSent = 0;
    for (const { siteId } of pendingSites) {
      if (!siteId) continue;

      // Count how many entries are pending for this site this week.
      const countRows = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(timeEntriesTable)
        .where(
          and(
            eq(timeEntriesTable.siteId, siteId),
            eq(timeEntriesTable.approvalStatus, "pending"),
            gte(timeEntriesTable.clockInTime, weekStart),
            lt(timeEntriesTable.clockInTime, weekEnd),
          ),
        );
      const pendingCount = countRows[0]?.count ?? 0;
      if (pendingCount === 0) continue;

      // Atomically stamp the site so concurrent ticks never double-send.
      const stamped = await db
        .update(sitesTable)
        .set({ teApprovalReminderWeek: weekKey })
        .where(
          and(
            eq(sitesTable.id, siteId),
            sql`${sitesTable.teApprovalReminderWeek} IS DISTINCT FROM ${weekKey}`,
          ),
        )
        .returning({ id: sitesTable.id });
      if (stamped.length === 0) continue; // another tick/instance got it

      const managerIds = await getSiteManagerUserIds(siteId);
      if (managerIds.length === 0) {
        // No active managers — leave stamp in place so we don't spam on
        // every future tick. When a manager is assigned mid-week they'll
        // see the entries in-app.
        continue;
      }

      const pushBody =
        `${pendingCount} time ${pendingCount === 1 ? "entry" : "entries"} need your approval before this week's payroll locks — please review today.`;
      const smsBody =
        `SecureOps: ${pendingCount} time ${pendingCount === 1 ? "entry" : "entries"} at your site need approval before this week's payroll locks. Please log in to review.`;

      let pushOk = false;
      try {
        await sendPushToUsers(managerIds, {
          title: "📋 Time Entries Need Approval",
          body: pushBody,
          data: { type: "te_approval_reminder", siteId, weekKey, pendingCount },
        });
        pushOk = true;
      } catch (err) {
        logger.warn({ err, siteId }, "[weekly-te-approval] push send failed");
      }

      try {
        await sendSmsToUsers(managerIds, smsBody);
      } catch (err) {
        logger.warn({ err, siteId }, "[weekly-te-approval] sms send failed");
      }

      if (!pushOk) {
        // Roll back the stamp so the next tick retries.
        await db
          .update(sitesTable)
          .set({ teApprovalReminderWeek: null })
          .where(eq(sitesTable.id, siteId))
          .catch(() => {/* swallow */});
        continue;
      }
      totalSent += 1;
    }

    if (totalSent > 0) {
      logger.info({ totalSent, weekKey }, "Sent weekly time-entry approval reminders");
    }
  } catch (err) {
    logger.error({ err }, "[weekly-te-approval] job failed");
  }
}

export function startScheduledJobs(intervalMs: number = HOUR_MS): NodeJS.Timeout[] {
  const handles: NodeJS.Timeout[] = [];

  /**
   * Training-certification expiry reminders. Same 60/30/14/7-day tiered
   * pattern as license reminders (idempotent via lastReminderTier +
   * lastReminderForExpiry, atomic UPDATE...RETURNING claim, rollback on
   * total delivery failure). Skips rows with no expiryDate (perpetual
   * certs like site-induction with no formal renewal).
   */
  async function sendTrainingExpiryReminders(): Promise<void> {
    try {
      const tiers = [60, 30, 14, 7];
      const today = new Date();
      const todayDateOnly = today.toISOString().slice(0, 10);

      let totalSent = 0;
      for (const tier of tiers) {
        const cutoff = new Date(today.getTime() + tier * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const candidates = await db
          .select({
            id: trainingCertificationsTable.id,
            employeeId: trainingCertificationsTable.employeeId,
            type: trainingCertificationsTable.type,
            title: trainingCertificationsTable.title,
            expiryDate: trainingCertificationsTable.expiryDate,
            firstName: usersTable.firstName,
            email: usersTable.email,
          })
          .from(trainingCertificationsTable)
          .innerJoin(usersTable, eq(usersTable.id, trainingCertificationsTable.employeeId))
          .where(
            and(
              // Skip perpetual certs (no expiry on file).
              sql`${trainingCertificationsTable.expiryDate} IS NOT NULL`,
              gte(trainingCertificationsTable.expiryDate, todayDateOnly),
              lte(trainingCertificationsTable.expiryDate, cutoff),
              eq(usersTable.status, "active"),
              or(
                isNull(trainingCertificationsTable.lastReminderForExpiry),
                ne(trainingCertificationsTable.lastReminderForExpiry, trainingCertificationsTable.expiryDate),
                isNull(trainingCertificationsTable.lastReminderTier),
                gt(trainingCertificationsTable.lastReminderTier, tier),
              ),
            ),
          );

        for (const cert of candidates) {
          if (!cert.expiryDate) continue;
          const claimed = await db
            .update(trainingCertificationsTable)
            .set({
              lastReminderTier: tier,
              lastReminderSentAt: new Date(),
              lastReminderForExpiry: cert.expiryDate,
            })
            .where(
              and(
                eq(trainingCertificationsTable.id, cert.id),
                or(
                  isNull(trainingCertificationsTable.lastReminderForExpiry),
                  ne(trainingCertificationsTable.lastReminderForExpiry, cert.expiryDate),
                  isNull(trainingCertificationsTable.lastReminderTier),
                  gt(trainingCertificationsTable.lastReminderTier, tier),
                ),
              ),
            )
            .returning({ id: trainingCertificationsTable.id });
          if (claimed.length === 0) continue;

          const expiry = new Date(cert.expiryDate);
          const daysRemaining = Math.max(
            0,
            Math.ceil((expiry.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
          );
          const tpl = renderTrainingExpiryEmail({
            firstName: cert.firstName ?? "there",
            trainingTitle: cert.title,
            trainingType: cert.type,
            expiryDate: cert.expiryDate,
            daysRemaining,
          });

          let emailOk = false;
          let pushOk = false;
          try {
            emailOk = await sendEmail({ to: cert.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
          } catch (err) {
            logger.warn({ err, trainingId: cert.id }, "[training-expiry] email send failed");
          }
          try {
            await sendPushToUsers([cert.employeeId], {
              title: `Training expires in ${daysRemaining} days`,
              body: `${cert.title} expires on ${cert.expiryDate}. Please renew.`,
              data: { type: "training_expiry_reminder", trainingId: cert.id, tier },
            });
            pushOk = true;
          } catch (err) {
            logger.warn({ err, trainingId: cert.id }, "[training-expiry] push send failed");
          }

          if (!emailOk && !pushOk) {
            await db
              .update(trainingCertificationsTable)
              .set({ lastReminderTier: null, lastReminderSentAt: null, lastReminderForExpiry: null })
              .where(eq(trainingCertificationsTable.id, cert.id))
              .catch((err) => logger.warn({ err, trainingId: cert.id }, "[training-expiry] failed to rollback bookkeeping"));
            continue;
          }
          totalSent += 1;
        }
      }
      if (totalSent > 0) {
        logger.info({ totalSent }, "Sent training expiry reminders");
      }
    } catch (err) {
      logger.error({ err }, "[training-expiry] reminder job failed");
    }
  }

  // sendPreShiftReminders is module-scope (exported) for direct test
  // invocation; resolves lexically below in schedule(...).
  void sendPreShiftReminders;

  /**
   * Missed-checkpoint pager. For each currently-clocked-in officer at a
   * site that has `patrol_interval_minutes` configured, page admins if
   * the officer has been silent for longer than that interval. Reference
   * point per shift = MAX(clock-in, most-recent-scan-at-this-site).
   * Debounced via `time_entries.patrol_last_notified_at` so admins get
   * at most one page per missed window per active shift.
   */
  async function checkMissedPatrolCheckpoints(): Promise<void> {
    try {
      // Pull every open time_entry whose site has an interval set.
      const actives = await db
        .select({
          id: timeEntriesTable.id,
          employeeId: timeEntriesTable.employeeId,
          siteId: timeEntriesTable.siteId,
          clockInTime: timeEntriesTable.clockInTime,
          patrolLastNotifiedAt: timeEntriesTable.patrolLastNotifiedAt,
          intervalMin: sitesTable.patrolIntervalMinutes,
          siteName: sitesTable.name,
        })
        .from(timeEntriesTable)
        .innerJoin(sitesTable, eq(timeEntriesTable.siteId, sitesTable.id))
        .where(and(
          isNull(timeEntriesTable.clockOutTime),
          // intervalMin IS NOT NULL
          sql`${sitesTable.patrolIntervalMinutes} IS NOT NULL`,
        ));

      if (actives.length === 0) return;

      const admins = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.role, "admin"));
      const adminIds = admins.map((a) => a.id);
      if (adminIds.length === 0) return;

      const now = Date.now();
      let pagedCount = 0;

      for (const a of actives) {
        const intervalMin = a.intervalMin!;
        // Safety: misconfigured (zero/negative) intervals would loop the pager
        // every tick. Skip silently.
        if (!Number.isFinite(intervalMin) || intervalMin < 1) continue;
        const intervalMs = intervalMin * 60 * 1000;
        // Most recent scan at this site by this officer.
        const [latest] = await db
          .select({ scannedAt: patrolScansTable.scannedAt })
          .from(patrolScansTable)
          .where(and(
            eq(patrolScansTable.userId, a.employeeId),
            eq(patrolScansTable.siteId, a.siteId!),
          ))
          .orderBy(sql`${patrolScansTable.scannedAt} DESC`)
          .limit(1);

        const reference = latest?.scannedAt && latest.scannedAt > a.clockInTime
          ? latest.scannedAt
          : a.clockInTime;
        if (now - reference.getTime() <= intervalMs) continue;

        // Debounce: don't re-page within the same interval window.
        if (a.patrolLastNotifiedAt && now - a.patrolLastNotifiedAt.getTime() < intervalMs) continue;

        // Claim the page atomically — UPDATE … RETURNING so two ticks can't double-page.
        const claim = await db.update(timeEntriesTable)
          .set({ patrolLastNotifiedAt: new Date() })
          .where(and(
            eq(timeEntriesTable.id, a.id),
            // Guard: only claim if the timestamp we read is still the current one.
            a.patrolLastNotifiedAt == null
              ? isNull(timeEntriesTable.patrolLastNotifiedAt)
              : eq(timeEntriesTable.patrolLastNotifiedAt, a.patrolLastNotifiedAt),
          ))
          .returning({ id: timeEntriesTable.id });
        if (claim.length === 0) continue;

        // Re-check freshness AFTER the claim — if the officer scanned between
        // our read and the claim, roll back the debounce stamp and skip the
        // page (the next tick will be a clean reference).
        const [postCheck] = await db
          .select({ scannedAt: patrolScansTable.scannedAt })
          .from(patrolScansTable)
          .where(and(
            eq(patrolScansTable.userId, a.employeeId),
            eq(patrolScansTable.siteId, a.siteId!),
          ))
          .orderBy(sql`${patrolScansTable.scannedAt} DESC`)
          .limit(1);
        const postRef = postCheck?.scannedAt && postCheck.scannedAt > a.clockInTime
          ? postCheck.scannedAt
          : a.clockInTime;
        if (now - postRef.getTime() <= intervalMs) {
          await db.update(timeEntriesTable)
            .set({ patrolLastNotifiedAt: a.patrolLastNotifiedAt })
            .where(eq(timeEntriesTable.id, a.id))
            .catch(() => {/* swallow */});
          continue;
        }

        // Look up the officer's name for the page body.
        const [officer] = await db
          .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
          .from(usersTable)
          .where(eq(usersTable.id, a.employeeId))
          .limit(1);
        const officerName = officer
          ? `${officer.firstName ?? ""} ${officer.lastName ?? ""}`.trim() || "Officer"
          : "Officer";

        try {
          await sendPushToUsers(adminIds, {
            title: "⚠ Missed patrol checkpoint",
            body: `${officerName} hasn't scanned at ${a.siteName} for over ${intervalMin}m.`,
            data: { type: "missed_checkpoint", siteId: a.siteId!, timeEntryId: a.id },
          });
          pagedCount += 1;
        } catch (err) {
          // Roll back the debounce stamp so the next tick retries this officer.
          await db.update(timeEntriesTable)
            .set({ patrolLastNotifiedAt: a.patrolLastNotifiedAt })
            .where(eq(timeEntriesTable.id, a.id))
            .catch(() => {/* swallow */});
          logger.error({ err, timeEntryId: a.id }, "[missed-checkpoint] push failed");
        }
      }

      if (pagedCount > 0) {
        logger.info({ pagedCount }, "Paged admins for missed patrol checkpoints");
      }
    } catch (err) {
      logger.error({ err }, "[missed-checkpoint] job failed");
    }
  }

  /**
   * High-risk self-edit digest. Walks `high_risk_change_queue`, finds
   * officers whose OLDEST pending row is at least `HIGH_RISK_DIGEST_WINDOW_MS`
   * old, atomically claims their rows via DELETE … RETURNING (so two
   * instances can never double-send the same digest), and fans out a
   * single push + a single email to every active admin listing every
   * field that changed in the window. On total delivery failure the
   * rows are re-inserted with their original detectedAt so the next
   * tick retries.
   *
   * Dedup: if the same field shows up multiple times in the window
   * (officer flipped their account number back and forth) it collapses
   * to one digest row, ordered by the earliest detectedAt — admins
   * still see "this field changed", but not N near-identical entries.
   */
  async function flushHighRiskSelfEditDigests(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - HIGH_RISK_DIGEST_WINDOW_MS);
      // Find officers whose oldest pending row is at least one window old.
      // GROUP BY + HAVING keeps us from sending half-baked digests for
      // officers who just started a burst of edits.
      const due = await db.execute<{ employee_user_id: string }>(sql`
        SELECT employee_user_id
        FROM ${highRiskChangeQueueTable}
        GROUP BY employee_user_id
        HAVING MIN(${highRiskChangeQueueTable.detectedAt}) <= ${cutoff}
      `);
      const dueIds = (due.rows ?? []).map((r) => r.employee_user_id);
      if (dueIds.length === 0) return;

      // Pre-fetch the active-admin list once per tick — every digest in
      // this tick goes to the same audience.
      const admins = await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
      if (admins.length === 0) {
        // No admins to notify — drop the queue so it doesn't grow forever
        // (the change log still has the full per-field history).
        await db
          .delete(highRiskChangeQueueTable)
          .where(inArray(highRiskChangeQueueTable.employeeUserId, dueIds))
          .catch((err) => logger.warn({ err }, "[high-risk-digest] failed to drain queue with no admins"));
        return;
      }
      const adminIds = admins.map((a) => a.id);
      // Profile self-edit EMAIL alerts go ONLY to the dedicated admin inbox
      // (in-app push below still reaches every admin).
      const adminEmails = [brand.adminNotifyEmail];

      const base = process.env.APP_BASE_URL
        || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "");

      let totalSent = 0;
      for (const employeeUserId of dueIds) {
        // Atomically claim every pending row for this officer. Anything
        // written after this DELETE will land in the NEXT digest.
        const claimed = await db
          .delete(highRiskChangeQueueTable)
          .where(eq(highRiskChangeQueueTable.employeeUserId, employeeUserId))
          .returning();
        if (claimed.length === 0) continue;

        // Dedup repeated edits of the same field down to the earliest
        // detectedAt for that field, then sort earliest → latest so the
        // digest reads in the order it happened.
        const byField = new Map<string, Date>();
        for (const row of claimed) {
          const prev = byField.get(row.field);
          if (!prev || row.detectedAt < prev) byField.set(row.field, row.detectedAt);
        }
        const dedupedChanges = Array.from(byField.entries())
          .map(([field, when]) => ({ field, when }))
          .sort((a, b) => a.when.getTime() - b.when.getTime());

        const [officer] = await db
          .select({
            firstName: usersTable.firstName,
            lastName: usersTable.lastName,
            email: usersTable.email,
          })
          .from(usersTable)
          .where(eq(usersTable.id, employeeUserId))
          .limit(1);
        // Officer deleted between enqueue and flush — nothing to send.
        if (!officer) continue;
        const officerName = [officer.firstName, officer.lastName].filter(Boolean).join(" ") || officer.email;

        const changes = dedupedChanges.map((c) => ({
          label: CHANGE_FIELD_LABELS[c.field] ?? c.field,
          whenIso: c.when.toISOString(),
        }));
        const windowStartIso = dedupedChanges[0]!.when.toISOString();
        const windowEndIso = dedupedChanges[dedupedChanges.length - 1]!.when.toISOString();
        const reviewUrl = base ? `${base}/admin-portal/personnel/${employeeUserId}/changes` : undefined;

        let pushOk = false;
        let emailOk = false;
        try {
          const labels = changes.map((c) => c.label);
          await sendPushToUsers(adminIds, {
            title: "Officer self-edit alert",
            body: `${officerName} updated ${labels.length === 1 ? labels[0] : `${labels.length} sensitive fields`}. Tap to review.`,
            data: {
              type: "high_risk_profile_change",
              employeeUserId,
              fields: dedupedChanges.map((c) => c.field),
            },
          });
          pushOk = true;
        } catch (err) {
          logger.warn({ err, employeeUserId }, "[high-risk-digest] push send failed");
        }

        try {
          const tmpl = renderHighRiskProfileChangeEmail({
            officerName,
            officerEmail: officer.email,
            changes,
            windowStartIso,
            windowEndIso,
            reviewUrl,
          });
          const results = await Promise.all(
            adminEmails.map((to) =>
              sendEmail({ to, subject: tmpl.subject, text: tmpl.text, html: tmpl.html })
                .catch((err) => {
                  logger.warn({ err, to, employeeUserId }, "[high-risk-digest] per-admin email failed");
                  return false;
                }),
            ),
          );
          emailOk = results.some(Boolean);
        } catch (err) {
          logger.warn({ err, employeeUserId }, "[high-risk-digest] email send failed");
        }

        if (!pushOk && !emailOk) {
          // Total delivery failure — re-insert the claimed rows so the
          // next tick retries. Preserve original detectedAt so the
          // 15-min window doesn't reset and a long-stuck SMTP outage
          // can't silently hide the alert.
          try {
            await db.insert(highRiskChangeQueueTable).values(
              claimed.map((r) => ({
                employeeUserId: r.employeeUserId,
                field: r.field,
                detectedAt: r.detectedAt,
              })),
            );
          } catch (err) {
            logger.error({ err, employeeUserId }, "[high-risk-digest] failed to re-enqueue after delivery failure");
          }
          continue;
        }
        totalSent += 1;
      }
      if (totalSent > 0) {
        logger.info({ totalSent }, "Sent high-risk self-edit digests");
      }
    } catch (err) {
      logger.error({ err }, "[high-risk-digest] job failed");
    }
  }

  /**
   * Forgot-to-clock-out reminders. For each officer who is still clocked
   * in past their assigned shift's scheduled end, push a friendly nudge
   * at ~20m and ~60m after end. Skips entries with no linked shift
   * (drop-in clock-ins have no scheduled end). Idempotent via
   * `time_entries.clock_out_reminder1_sent_at` / `_reminder2_sent_at`,
   * claimed atomically via UPDATE … RETURNING so two overlapping ticks
   * never double-send.
   */
  async function sendForgotClockOutReminders(): Promise<void> {
    try {
      const now = Date.now();
      const windows: Array<{
        minOffset: number;
        maxOffset: number;
        column: "clockOutReminder1SentAt" | "clockOutReminder2SentAt";
        label: string;
      }> = [
        // ~20 minutes past scheduled end. Window: 15–45m so a 5-minute
        // tick can't miss it and a long previous tick can still catch up.
        { minOffset: 15 * MIN_MS, maxOffset: 45 * MIN_MS, column: "clockOutReminder1SentAt", label: "first" },
        // ~60 minutes past scheduled end, then stop.
        { minOffset: 55 * MIN_MS, maxOffset: 24 * HOUR_MS, column: "clockOutReminder2SentAt", label: "second" },
      ];

      let totalSent = 0;
      for (const w of windows) {
        const sentColumn = w.column === "clockOutReminder1SentAt"
          ? timeEntriesTable.clockOutReminder1SentAt
          : timeEntriesTable.clockOutReminder2SentAt;
        // Officer scheduled end happened between (now - maxOffset) and (now - minOffset).
        const endMin = new Date(now - w.maxOffset);
        const endMax = new Date(now - w.minOffset);

        const rows = await db
          .select({
            entryId: timeEntriesTable.id,
            employeeId: timeEntriesTable.employeeId,
            siteName: sitesTable.name,
          })
          .from(timeEntriesTable)
          .innerJoin(shiftsTable, eq(shiftsTable.id, timeEntriesTable.shiftId))
          .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
          .where(and(
            isNull(timeEntriesTable.clockOutTime),
            isNull(sentColumn),
            gte(shiftsTable.endTime, endMin),
            lte(shiftsTable.endTime, endMax),
          ));

        for (const r of rows) {
          const claimed = await db
            .update(timeEntriesTable)
            .set(w.column === "clockOutReminder1SentAt"
              ? { clockOutReminder1SentAt: new Date() }
              : { clockOutReminder2SentAt: new Date() })
            .where(and(
              eq(timeEntriesTable.id, r.entryId),
              isNull(timeEntriesTable.clockOutTime),
              isNull(sentColumn),
            ))
            .returning({ id: timeEntriesTable.id });
          if (claimed.length === 0) continue;

          const where = r.siteName ? r.siteName : "your shift";
          let pushOk = false;
          try {
            await sendPushToUsers([r.employeeId], {
              title: "Don't forget to clock out",
              body: `Your shift at ${where} has ended. Tap to clock out.`,
              data: { type: "forgot_clock_out", timeEntryId: r.entryId, tier: w.label },
            });
            pushOk = true;
          } catch (err) {
            logger.warn({ err, timeEntryId: r.entryId }, "[forgot-clock-out] push send failed");
          }
          if (!pushOk) {
            // Roll back claim so a later tick can retry.
            await db
              .update(timeEntriesTable)
              .set(w.column === "clockOutReminder1SentAt"
                ? { clockOutReminder1SentAt: null }
                : { clockOutReminder2SentAt: null })
              .where(eq(timeEntriesTable.id, r.entryId))
              .catch(() => {/* swallow */});
            continue;
          }
          totalSent += 1;
        }
      }
      if (totalSent > 0) {
        logger.info({ totalSent }, "Sent forgot-clock-out reminders");
      }
    } catch (err) {
      logger.error({ err }, "[forgot-clock-out] job failed");
    }
  }

  /**
   * Auto clock-out after shift end. For each officer still clocked in
   * more than AUTO_CLOCKOUT_GRACE_MS past their assigned shift's
   * scheduled end, close the open time entry — UNLESS we can confirm
   * they are still physically on site (inside the geofence).
   *
   * "Still within the geofence" = the time entry's `geofence_state` is
   * `inside` AND the officer's last location ping is recent
   * (`GEOFENCE_FRESH_MS`). We require freshness because a stale `inside`
   * (phone stopped pinging an hour ago) is exactly the forgotten-clock-out
   * case this job exists to clean up; trusting it would keep the officer
   * clocked in forever. If we cannot confirm they are on site
   * (`outside`, never evaluated, or a stale ping), we clock them out.
   *
   * Clock-out time = the shift's scheduled end (not "now"), so payroll
   * reflects the shift the officer was actually scheduled for and the
   * result is deterministic regardless of when the tick fires. Officers
   * still inside the geofence are left alone and instead receive the
   * forgot-to-clock-out nudges; this job re-checks them every tick and
   * closes them out once they leave.
   *
   * Idempotent + race-safe: the close is an atomic
   * UPDATE … WHERE clock_out_time IS NULL … RETURNING, so an entry can
   * only be claimed once even across overlapping ticks / instances. A
   * closed entry drops out of the next query naturally (no bookkeeping
   * column needed). The officer push is best-effort and never rolls back
   * the clock-out — the DB write is the action, the notification is a
   * courtesy.
   */
  async function autoClockOutEndedShifts(): Promise<void> {
    try {
      const now = Date.now();
      const cutoff = new Date(now - AUTO_CLOCKOUT_GRACE_MS);

      const rows = await db
        .select({
          entryId: timeEntriesTable.id,
          employeeId: timeEntriesTable.employeeId,
          clockInTime: timeEntriesTable.clockInTime,
          notes: timeEntriesTable.notes,
          geofenceState: timeEntriesTable.geofenceState,
          shiftId: timeEntriesTable.shiftId,
          shiftEndTime: shiftsTable.endTime,
          lastLocationAt: usersTable.lastLocationAt,
          siteName: sitesTable.name,
          autoClockOutEnabled: sitesTable.autoClockOutEnabled,
        })
        .from(timeEntriesTable)
        .innerJoin(shiftsTable, eq(shiftsTable.id, timeEntriesTable.shiftId))
        .innerJoin(usersTable, eq(usersTable.id, timeEntriesTable.employeeId))
        .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
        .where(and(
          isNull(timeEntriesTable.clockOutTime),
          lte(shiftsTable.endTime, cutoff),
        ));

      let totalClosed = 0;
      for (const r of rows) {
        // Skip if auto-clock-out is disabled for this site (null = no site →
        // treat as enabled so siteless shifts still auto-clock-out).
        if (r.autoClockOutEnabled === false) continue;

        // Skip officers we can confirm are still on site.
        const pingFresh =
          r.lastLocationAt != null &&
          now - r.lastLocationAt.getTime() <= GEOFENCE_FRESH_MS;
        if (r.geofenceState === "inside" && pingFresh) continue;

        // Clock out at the scheduled end. Guard against negative hours
        // for odd entries clocked in after their shift's end (e.g. a
        // late drop-in) by falling back to now().
        const scheduledEnd = new Date(r.shiftEndTime);
        const clockOut = scheduledEnd.getTime() > r.clockInTime.getTime()
          ? scheduledEnd
          : new Date(now);
        const hours = Math.round(
          ((clockOut.getTime() - r.clockInTime.getTime()) / 3_600_000) * 100,
        ) / 100;

        const marker = "Auto clocked out: shift ended, officer not within geofence.";
        const nextNotes = r.notes ? `${r.notes} | ${marker}` : marker;

        const claimed = await db
          .update(timeEntriesTable)
          .set({
            clockOutTime: clockOut,
            hoursWorked: String(hours),
            notes: nextNotes,
          })
          .where(and(
            eq(timeEntriesTable.id, r.entryId),
            isNull(timeEntriesTable.clockOutTime),
          ))
          .returning({ id: timeEntriesTable.id, shiftId: timeEntriesTable.shiftId });
        if (claimed.length === 0) continue; // another tick/instance got it

        // Complete the shift iff no other officer is still clocked in on
        // it — same TOCTOU-safe NOT EXISTS predicate as manual clock-out.
        const claimedShiftId = claimed[0]!.shiftId;
        if (claimedShiftId) {
          await db
            .update(shiftsTable)
            .set({ status: "completed" })
            .where(and(
              eq(shiftsTable.id, claimedShiftId),
              eq(shiftsTable.status, "active"),
              sql`NOT EXISTS (
                SELECT 1 FROM ${timeEntriesTable}
                WHERE ${timeEntriesTable.shiftId} = ${claimedShiftId}
                  AND ${timeEntriesTable.clockOutTime} IS NULL
              )`,
            ))
            .catch((err) => logger.warn({ err, shiftId: claimedShiftId }, "[auto-clock-out] failed to complete shift"));
        }

        // Best-effort courtesy push. Never rolls back the clock-out.
        const where = r.siteName ? r.siteName : "your shift";
        sendPushToUsers([r.employeeId], {
          title: "You were clocked out",
          body: `Your shift at ${where} ended and you'd left the area, so we clocked you out automatically.`,
          data: { type: "auto_clock_out", timeEntryId: r.entryId },
        }).catch((err: unknown) => logger.warn({ err, timeEntryId: r.entryId }, "[auto-clock-out] push send failed"));

        totalClosed += 1;
      }

      if (totalClosed > 0) {
        logger.info({ totalClosed }, "Auto clocked out officers past shift end");
      }
    } catch (err) {
      logger.error({ err }, "[auto-clock-out] job failed");
    }
  }

  // Wrap a job with an in-process mutex so a slow tick never overlaps
  // its own next tick. Cross-instance protection comes from the atomic
  // UPDATE-RETURNING claims inside each job.
  function withMutex(name: string, fn: () => Promise<void>): () => Promise<void> {
    let running = false;
    return async () => {
      if (running) {
        logger.debug({ job: name }, "[scheduler] previous tick still running; skipping");
        return;
      }
      running = true;
      try { await fn(); } finally { running = false; }
    };
  }

  function schedule(name: string, fn: () => Promise<void>, ms: number, runImmediately = true): void {
    const guarded = withMutex(name, fn);
    if (runImmediately) void guarded();
    const handle = setInterval(() => void guarded(), ms);
    if (typeof handle.unref === "function") handle.unref();
    handles.push(handle);
  }

  async function cleanupExpiredApplicationDrafts(): Promise<void> {
    try {
      const now = new Date();
      const result = await db
        .delete(applicationDraftsTable)
        .where(lt(applicationDraftsTable.expiresAt, now));
      const removed = (result as { rowCount?: number | null }).rowCount ?? 0;
      if (removed > 0) {
        logger.info({ removed }, "Cleaned up expired application drafts");
      }
    } catch (err) {
      logger.error({ err }, "Failed to clean up expired application drafts");
    }
  }

  // Prune old location-ping breadcrumb rows. Officer trails are stored
  // per ping (~1/min while clocked in) so the table grows linearly with
  // headcount; 30 days is well past anything Dispatch / incident review
  // looks at and bounds storage.
  async function cleanupOldLocationPings(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await db
        .delete(locationPingsTable)
        .where(lt(locationPingsTable.capturedAt, cutoff));
      const removed = (result as { rowCount?: number | null }).rowCount ?? 0;
      if (removed > 0) {
        logger.info({ removed }, "Cleaned up old location pings");
      }
    } catch (err) {
      logger.error({ err }, "Failed to clean up location pings");
    }
  }

  // Hourly maintenance.
  schedule("revoked-tokens", cleanupExpiredRevokedTokens, intervalMs);
  schedule("application-drafts", cleanupExpiredApplicationDrafts, intervalMs);
  schedule("location-pings", cleanupOldLocationPings, intervalMs);
  // License expiry — hourly is plenty (and idempotent), avoids a
  // mid-day spike if many licenses cluster on one expiry date.
  schedule("license-expiry", sendLicenseExpiryReminders, intervalMs);
  // Training-cert expiry — same hourly cadence as license expiry.
  schedule("training-expiry", sendTrainingExpiryReminders, intervalMs);
  // Subcontractor COI expiry — hourly, idempotent, fans out to active admins.
  schedule("coi-expiry", sendCoiExpiryReminders, intervalMs);
  // Pre-shift reminders — every 5 minutes is the right cadence for the
  // 30-minute window without being too chatty.
  schedule("shift-reminders", sendPreShiftReminders, 5 * MIN_MS);
  // Missed-checkpoint pages — every 5 minutes; debounced per active shift.
  schedule("missed-checkpoints", checkMissedPatrolCheckpoints, 5 * MIN_MS);
  // High-risk self-edit digest — every 5 minutes. The 15-min coalescing
  // window is enforced inside the job; the tick cadence just bounds how
  // long an admin waits after the window closes.
  schedule("high-risk-digest", flushHighRiskSelfEditDigests, 5 * MIN_MS);
  // Forgot-to-clock-out — every 5 minutes; idempotent per active shift.
  schedule("forgot-clock-out", sendForgotClockOutReminders, 5 * MIN_MS);
  // Auto clock-out officers >10m past shift end who aren't still on site
  // — every 5 minutes; atomic claim makes it idempotent per entry.
  schedule("auto-clock-out", autoClockOutEndedShifts, 5 * MIN_MS);
  // Recover payroll rows stuck in 'processing' (a PNC rollback that itself
  // failed) — every 5 minutes; the 15-min age threshold cannot race a
  // legitimate in-flight submission.
  schedule("payroll-stuck-sweep", recoverStuckProcessingPayrollRows, 5 * MIN_MS);
  // Lock draft invoices whose week has ended (Mon 00:00 UTC). After
  // locking, new approvals for that site roll into a fresh draft for
  // the following week. Hourly is enough — the boundary check is purely
  // by period_end < today, so even one tick on Monday morning catches up.
  schedule("invoice-week-lock", lockEndedWeekInvoices, intervalMs);
  // Scheduler reconciliation safety net — every 15 minutes. Fetches any
  // shifts/clock-events the scheduler published while SecureOps was down or
  // mid-restart. Skips silently when the integration is not configured.
  schedule("scheduler-reconcile", runSchedulerReconciliation, 15 * MIN_MS);
  // Pending shift-claim approval reminders — hourly. Nudges site managers
  // when a claim has been waiting in pending_approval for more than 2 hours.
  // Idempotent via shift_assignments.claim_reminder_sent_at.
  logger.info("Scheduled job: pending-claim-reminders (hourly)");
  schedule("pending-claim-reminders", sendPendingClaimReminders, intervalMs);
  // Unconfirmed time-entry reminders — every 5 minutes so an officer is
  // nudged close to the 1-hour mark after clock-out. One reminder per
  // entry, ever (atomic claim on confirmation_reminder_sent_at).
  schedule("confirm-entry-reminders", sendUnconfirmedEntryReminders, 5 * MIN_MS);
  // Weekly time-entry approval reminders — hourly tick, self-gates to
  // Fridays 17:00–19:00 business timezone. Nudges site managers who have
  // unapproved time entries for the current pay week.
  // Idempotent via sites.te_approval_reminder_week.
  logger.info("Scheduled job: weekly-te-approval-reminders (hourly, Friday gate)");
  schedule("weekly-te-approval-reminders", sendWeeklyTimeEntryApprovalReminders, intervalMs);
  // Suppress lint about unused sql import.
  void sql;

  return handles;
}

// ---------------------------------------------------------------------------
// Event Staff Scheduler reconciliation job
// ---------------------------------------------------------------------------

/**
 * Pull any missed shifts/clock-events from the scheduler since the stored
 * cursor, apply them via the shared upsert logic, and advance the cursor.
 *
 * Safe to call concurrently: the cursor UPDATE is atomic (INSERT ON CONFLICT
 * DO UPDATE); a second tick that starts before the first finishes will re-read
 * the same cursor and re-apply the same payload (idempotent).
 */
export async function runSchedulerReconciliation(): Promise<void> {
  if (!isSchedulerConfigured()) return;

  // Lazily import to avoid circular deps at module-load time.
  const { reconcileSchedulerDelta } = await import("../routes/schedulerWebhook");

  const [cursor] = await db
    .select()
    .from(schedulerSyncCursorsTable)
    .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));

  const since = cursor?.cursorValue ?? "1970-01-01T00:00:00.000Z";

  const delta = await fetchSchedulerDelta(since);
  if (!delta) {
    // fetchSchedulerDelta already logged a warning; record the error.
    const now = new Date();
    await db
      .insert(schedulerSyncCursorsTable)
      .values({
        cursorKey: "shifts",
        cursorValue: since,
        lastSyncAt: now,
        lastSyncError: "fetchSchedulerDelta failed — see server logs",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schedulerSyncCursorsTable.cursorKey,
        set: {
          lastSyncAt: now,
          lastSyncError: "fetchSchedulerDelta failed — see server logs",
          updatedAt: now,
        },
      });
    return;
  }

  let counts: Awaited<ReturnType<typeof reconcileSchedulerDelta>>;
  try {
    counts = await reconcileSchedulerDelta(delta.shifts, delta.clockEvents);
  } catch (err) {
    logger.error({ err }, "[scheduler-reconcile] reconcileSchedulerDelta threw");
    return;
  }

  const now = new Date();
  const nextCursor = delta.nextCursor ?? now.toISOString();

  await db
    .insert(schedulerSyncCursorsTable)
    .values({
      cursorKey: "shifts",
      cursorValue: nextCursor,
      lastSyncAt: now,
      lastSyncError: null,
      lastSyncShiftsProcessed: String(
        counts.shiftsCreated + counts.shiftsUpdated + counts.shiftsDeleted,
      ),
      lastSyncEventsProcessed: String(
        counts.eventsCreated + counts.eventsUpdated + counts.eventsDeleted,
      ),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schedulerSyncCursorsTable.cursorKey,
      set: {
        cursorValue: nextCursor,
        lastSyncAt: now,
        lastSyncError: null,
        lastSyncShiftsProcessed: String(
          counts.shiftsCreated + counts.shiftsUpdated + counts.shiftsDeleted,
        ),
        lastSyncEventsProcessed: String(
          counts.eventsCreated + counts.eventsUpdated + counts.eventsDeleted,
        ),
        updatedAt: now,
      },
    });

  if (
    counts.shiftsCreated + counts.shiftsUpdated + counts.shiftsDeleted +
    counts.eventsCreated + counts.eventsUpdated + counts.eventsDeleted > 0
  ) {
    logger.info(
      { since, nextCursor, ...counts },
      "[scheduler-reconcile] delta applied",
    );
  }
}
