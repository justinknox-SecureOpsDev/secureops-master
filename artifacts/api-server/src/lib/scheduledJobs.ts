import { lt, eq, and, or, isNull, gt, gte, lte, ne, sql } from "drizzle-orm";
import {
  db,
  revokedTokensTable,
  licensesTable,
  usersTable,
  shiftsTable,
  shiftAssignmentsTable,
  sitesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { sendEmail, renderLicenseExpiryEmail } from "./email";
import { sendPushToUsers } from "./push";

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/**
 * Background maintenance jobs:
 *   1. Cleanup expired revoked-token rows (hourly).
 *   2. License expiry reminders — tiered emails + push at 30 / 14 / 7 days
 *      before expiry. Runs hourly but is idempotent: it persists
 *      `licenses.last_reminder_tier` AND `last_reminder_for_expiry` so
 *      a license is never reminded twice for the same tier on the
 *      same expiry, while a renewed license (different expiry) is
 *      treated as a clean slate and gets the full 30/14/7 cycle.
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
export function startScheduledJobs(intervalMs: number = HOUR_MS): NodeJS.Timeout[] {
  const handles: NodeJS.Timeout[] = [];

  async function cleanupExpiredRevokedTokens(): Promise<void> {
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

  async function sendLicenseExpiryReminders(): Promise<void> {
    try {
      // Tiers run from biggest to smallest so a single sweep advances
      // bookkeeping correctly: a license that has not yet been
      // reminded at the 30-day tier still gets the 30-day notice when
      // it lands inside the 14-day window.
      const tiers = [30, 14, 7];
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

  async function sendPreShiftReminders(): Promise<void> {
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
            siteName: sitesTable.name,
          })
          .from(shiftAssignmentsTable)
          .innerJoin(shiftsTable, eq(shiftsTable.id, shiftAssignmentsTable.shiftId))
          .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
          .where(
            and(
              eq(shiftAssignmentsTable.status, "accepted"),
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

  // Hourly maintenance.
  schedule("revoked-tokens", cleanupExpiredRevokedTokens, intervalMs);
  // License expiry — hourly is plenty (and idempotent), avoids a
  // mid-day spike if many licenses cluster on one expiry date.
  schedule("license-expiry", sendLicenseExpiryReminders, intervalMs);
  // Pre-shift reminders — every 5 minutes is the right cadence for the
  // 30-minute window without being too chatty.
  schedule("shift-reminders", sendPreShiftReminders, 5 * MIN_MS);
  // Suppress lint about unused sql import.
  void sql;

  return handles;
}
