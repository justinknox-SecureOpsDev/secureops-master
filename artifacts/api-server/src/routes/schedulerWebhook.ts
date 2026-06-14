/**
 * Inbound webhook endpoints for the Event Staff Scheduler integration.
 *
 * The scheduler calls these when shifts or clock events change on its side.
 * Every request is authenticated via HMAC-SHA256 (X-WCSG-Signature header).
 *
 * Loop prevention: upserted records are written with syncSource='scheduler'
 * so the outbound push hook in shifts.ts / timeEntries.ts skips echoing them.
 *
 * Reconciliation: the shared `reconcileSchedulerDelta` helper is also used by
 * the scheduled safety-net job in scheduledJobs.ts.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, and, sql, gte, lte, or, inArray, notInArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db, shiftsTable, timeEntriesTable, usersTable, sitesTable, shiftAssignmentsTable, auditLogsTable } from "@workspace/db";
import { verifySignature, SCHEDULER_SOURCE, type SchedulerShiftPayload, type SchedulerClockEventPayload } from "../lib/schedulerSync";
import { getEffectiveLevel } from "../lib/eligibility";
import { validateShiftWindow } from "../lib/shiftWindow";
import { logger } from "../lib/logger";
import rateLimit, { MemoryStore } from "express-rate-limit";

const router: IRouter = Router();

// -------------------------------------------------------------------------
// Rate limiter: 120 req / 5 min per IP — generous for legitimate webhook
// traffic, tight enough to slow down brute-force signature guessing and
// DB-write flooding. The cap is env-configurable (default 120), mirroring
// the limiters in middlewares/rateLimit.ts so tests can drive a low
// override without firing 120+ requests.
//
// The store is exported so tests can reset the per-IP counter between cases
// (the limiter is shared across the whole app instance for the test run).
// -------------------------------------------------------------------------
function webhookRateLimit(): number {
  const raw = process.env.SCHEDULER_WEBHOOK_RATE_LIMIT;
  if (raw === undefined || raw === "") return 120;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

export const webhookRateLimitStore: MemoryStore = new MemoryStore();

const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: () => webhookRateLimit(),
  standardHeaders: true,
  legacyHeaders: false,
  store: webhookRateLimitStore,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ error: "Too Many Requests", message: "Webhook rate limit exceeded" });
  },
});

// -------------------------------------------------------------------------
// HMAC authentication middleware
// -------------------------------------------------------------------------
function requireHmac(req: Request, res: Response, next: NextFunction): void {
  const secret = (process.env.SCHEDULER_SHARED_SECRET ?? "").trim();
  if (!secret) {
    res.status(503).json({ error: "Service Unavailable", message: "Scheduler integration not configured" });
    return;
  }
  const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body);
  const sig = req.headers["x-wcsg-signature"] as string | undefined;
  if (!verifySignature(rawBody, sig, secret)) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or missing HMAC signature" });
    return;
  }
  next();
}

// -------------------------------------------------------------------------
// Zod schemas for inbound payloads
// -------------------------------------------------------------------------
const InboundShiftSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
  title: z.string().min(1).optional(),
  siteName: z.string().optional().nullable(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  payRate: z.string().optional().nullable(),
  billRate: z.string().optional().nullable(),
  requiredLicenseLevel: z.number().int().min(1).max(4).optional().nullable(),
  headcount: z.number().int().min(1).optional().nullable(),
  status: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  assignedOfficerEmails: z.array(z.string()).optional(),
  updatedAt: z.string(),
});
type InboundShift = z.infer<typeof InboundShiftSchema>;

const InboundClockEventSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
  employeeEmail: z.string().min(1).optional(),
  shiftId: z.string().optional().nullable(),
  siteName: z.string().optional().nullable(),
  clockInTime: z.string().optional(),
  clockOutTime: z.string().optional().nullable(),
  hoursWorked: z.string().optional().nullable(),
  updatedAt: z.string(),
});
type InboundClockEvent = z.infer<typeof InboundClockEventSchema>;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Resolve a SecureOps siteId by name (case-insensitive). */
async function resolveSiteByName(name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const [site] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(sql`lower(${sitesTable.name}) = lower(${name})`)
    .limit(1);
  return site?.id ?? null;
}

/** Resolve a SecureOps userId by email. */
async function resolveUserByEmail(email: string): Promise<string | null> {
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = lower(${email})`)
    .limit(1);
  return user?.id ?? null;
}

/** Find a SecureOps shiftId by externalId (from the scheduler). */
async function resolveShiftByExternalId(externalShiftId: string): Promise<string | null> {
  const [shift] = await db
    .select({ id: shiftsTable.id })
    .from(shiftsTable)
    .where(and(
      eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
      eq(shiftsTable.externalId, externalShiftId),
    ))
    .limit(1);
  return shift?.id ?? null;
}

// Clock-in deduplication tolerance window: 5 minutes either side
const DEDUP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Reconcile a shift's officer roster against the scheduler's authoritative
 * `assignedOfficerEmails` list. Shared by the webhook handler AND the scheduled
 * reconciliation job (via `processInboundShift`) so a roster change syncs the
 * same way whether it arrives by webhook or the periodic delta pull.
 *
 * We add an accepted assignment for each listed officer (idempotent) and remove
 * assignments for officers no longer listed — mirroring the decline path in
 * shifts.ts, which DELETEs the assignment to free the slot. Unknown emails are
 * silently skipped. An empty list clears the entire roster.
 *
 * Eligibility gate: per the "auto-assign on clock-in eligibility" invariant,
 * any path that creates an accepted shift_assignment must apply the same
 * licence-level check the manual claim / admin-assign routes use. The scheduler
 * is NOT trusted to have vetted officer clearance, so each listed officer's
 * effective level (`getEffectiveLevel`, max of unexpired licence level and the
 * support-staff baseline) is compared against the shift's `requiredLicenseLevel`.
 * Under-licensed officers are SKIPPED (never rostered) with a logged warning —
 * the conservative, fail-closed choice consistent with the claim route, which
 * 403s an unqualified officer. A skipped officer is treated exactly like an
 * unlisted one: not added, and removed if previously on the roster.
 */
async function reconcileShiftRoster(shiftId: string, assignedOfficerEmails: string[]): Promise<void> {
  // The shift's clearance bar. Defaults to 1 (support) if the row is somehow
  // missing a level, so we never gate harder than the shift actually requires.
  const [shiftLevelRow] = await db
    .select({ requiredLicenseLevel: shiftsTable.requiredLicenseLevel })
    .from(shiftsTable)
    .where(eq(shiftsTable.id, shiftId))
    .limit(1);
  const requiredLicenseLevel = shiftLevelRow?.requiredLicenseLevel ?? 1;

  // Resolve the listed emails to known officer userIds (unknown emails skipped),
  // then drop any officer whose effective licence level doesn't meet the shift's
  // requirement (logged, so dispatch can see who the scheduler tried to roster).
  const desiredUserIds = new Set<string>();
  const skipped: Array<{ userId: string; email: string; effLevel: number }> = [];
  for (const email of assignedOfficerEmails) {
    const userId = await resolveUserByEmail(email);
    if (!userId) continue;
    const effLevel = await getEffectiveLevel(userId);
    if (effLevel < requiredLicenseLevel) {
      logger.warn(
        { shiftId, userId, email, effLevel, requiredLicenseLevel },
        "scheduler-roster skipped under-licensed officer (effective level below shift requirement)",
      );
      skipped.push({ userId, email, effLevel });
      continue;
    }
    desiredUserIds.add(userId);
  }
  const desiredIds = [...desiredUserIds];

  // Snapshot the roster BEFORE mutating so we can compute who was actually
  // added vs. removed, and only notify officers whose status really changed
  // (mirrors the claim / admin-assign / decline flows, which notify on the
  // single roster change they perform).
  const existingRows = await db
    .select({ employeeId: shiftAssignmentsTable.employeeId })
    .from(shiftAssignmentsTable)
    .where(eq(shiftAssignmentsTable.shiftId, shiftId));
  const existingIds = new Set(existingRows.map((r) => r.employeeId));

  const addedIds = desiredIds.filter((id) => !existingIds.has(id));
  const removedIds = [...existingIds].filter((id) => !desiredUserIds.has(id));

  // Add: insert an accepted assignment for each desired officer (idempotent).
  for (const userId of desiredIds) {
    try {
      await db.insert(shiftAssignmentsTable).values({
        shiftId,
        employeeId: userId,
        status: "accepted",
      }).onConflictDoNothing();
    } catch {
      // ignore duplicate assignment errors
    }
  }

  // Remove: delete assignments for officers no longer in the scheduler's roster.
  if (desiredIds.length > 0) {
    await db.delete(shiftAssignmentsTable).where(and(
      eq(shiftAssignmentsTable.shiftId, shiftId),
      notInArray(shiftAssignmentsTable.employeeId, desiredIds),
    ));
  } else {
    await db.delete(shiftAssignmentsTable).where(
      eq(shiftAssignmentsTable.shiftId, shiftId),
    );
  }

  // Notify officers the scheduler just added / dropped, reusing the same push +
  // SMS helpers (and respecting their opt-in/consent rules) as the in-app
  // assign / decline flows. Because this runs from the webhook AND the scheduled
  // reconciliation job, scheduler-driven roster changes are surfaced no matter
  // which path applied them. Best-effort: notification failures must never fail
  // the sync or roll back the roster change.
  if (addedIds.length > 0 || removedIds.length > 0) {
    try {
      const [shiftRow] = await db
        .select({ title: shiftsTable.title, startTime: shiftsTable.startTime })
        .from(shiftsTable)
        .where(eq(shiftsTable.id, shiftId))
        .limit(1);
      const title = shiftRow?.title ?? "a shift";
      const { fmtShiftWhen } = await import("./shifts");
      const when = shiftRow?.startTime ? fmtShiftWhen(shiftRow.startTime) : "the scheduled time";
      const { sendPushToUsers } = await import("../lib/push");
      const { sendSmsToUsers } = await import("../lib/sms");

      if (addedIds.length > 0) {
        await sendPushToUsers(addedIds, {
          title: "📋 New Shift Assigned",
          body: `You've been assigned to ${title} on ${when}`,
          data: { type: "shift_assigned", shiftId },
        });
        sendSmsToUsers(
          addedIds,
          `[WCSG] You've been assigned to ${title} on ${when}. Open the app for details.`,
        ).catch((err: unknown) => logger.warn({ err, shiftId }, "scheduler-roster assign SMS dispatch failed"));
      }

      if (removedIds.length > 0) {
        await sendPushToUsers(removedIds, {
          title: "🚫 Shift Assignment Removed",
          body: `You've been removed from ${title} on ${when}`,
          data: { type: "shift_unassigned", shiftId },
        });
        sendSmsToUsers(
          removedIds,
          `[WCSG] You've been removed from ${title} on ${when}. Open the app for details.`,
        ).catch((err: unknown) => logger.warn({ err, shiftId }, "scheduler-roster removal SMS dispatch failed"));
      }
    } catch (err) {
      logger.warn({ err, shiftId }, "scheduler-roster change notification failed");
    }
  }

  // Surface eligibility skips to dispatch. The scheduler tried to roster these
  // officers but their effective licence level is below the shift's requirement,
  // so they were NOT added and the slot may quietly stay short-staffed. Make the
  // skip visible to admins two ways so it never goes unnoticed:
  //   1. A persistent audit-log row (action `scheduler.eligibility_skip`,
  //      queryable at /admin/audit-logs) recording officer + shift + their
  //      effective level + the required level.
  //   2. A real-time push to every admin, deep-linking to the shift so they can
  //      assign a qualified officer / open the slot.
  // Runs from the webhook AND the scheduled reconciliation job (both go through
  // here), so the skip surfaces no matter which path applied the sync.
  // Best-effort: failures here must never fail the sync or roll back the roster.
  if (skipped.length > 0) {
    try {
      const [shiftRow] = await db
        .select({ title: shiftsTable.title })
        .from(shiftsTable)
        .where(eq(shiftsTable.id, shiftId))
        .limit(1);
      const title = shiftRow?.title ?? "a shift";

      // Resolve names for the skipped officers so the records are human-readable.
      const nameRows = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName })
        .from(usersTable)
        .where(inArray(usersTable.id, skipped.map((s) => s.userId)));
      const nameById = new Map(
        nameRows.map((r) => [r.id, `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()]),
      );
      const skippedDetail = skipped.map((s) => ({
        userId: s.userId,
        email: s.email,
        name: nameById.get(s.userId) || s.email,
        effectiveLevel: s.effLevel,
        requiredLevel: requiredLicenseLevel,
      }));

      // 1. Persistent, queryable audit record (one row per sync, listing every
      //    skipped officer). System-actor: no req.user — the scheduler drove it.
      try {
        await db.insert(auditLogsTable).values({
          actorUserId: null,
          actorEmail: null,
          actorRole: "scheduler",
          action: "scheduler.eligibility_skip",
          targetTable: "shifts",
          targetId: shiftId,
          method: "POST",
          path: "/scheduler/roster-sync",
          statusCode: 200,
          ip: null,
          userAgent: null,
          metadata: { shiftId, shiftTitle: title, requiredLicenseLevel, skipped: skippedDetail },
        });
      } catch (err) {
        logger.warn({ err, shiftId }, "scheduler-roster eligibility-skip audit write failed");
      }

      // 2. Real-time alert to admins, deep-linking to the shift.
      const admins = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.role, "admin"));
      const adminIds = admins.map((a) => a.id);
      if (adminIds.length > 0) {
        const names = skippedDetail.map((s) => s.name).join(", ");
        const body =
          skippedDetail.length === 1
            ? `${names} can't be rostered on ${title} — their licence level (${skippedDetail[0]!.effectiveLevel}) is below the required level ${requiredLicenseLevel}. Assign a qualified officer.`
            : `${skippedDetail.length} officers can't be rostered on ${title} (below required licence level ${requiredLicenseLevel}): ${names}. Assign qualified officers.`;
        const { sendPushToUsers } = await import("../lib/push");
        await sendPushToUsers(adminIds, {
          title: "⚠️ Unqualified officer on schedule",
          body,
          data: { type: "scheduler_eligibility_skip", shiftId },
        });
      }
    } catch (err) {
      logger.warn({ err, shiftId }, "scheduler-roster eligibility-skip surfacing failed");
    }
  }
}

// -------------------------------------------------------------------------
// Last-write-wins conflict resolution
//
// The scheduler and SecureOps keep INDEPENDENT clocks. The inbound payload's
// `updatedAt` is stamped by the scheduler; the local row's `updatedAt` column
// is stamped by SecureOps's own server wall-clock at write time. Comparing
// those two directly is only valid up to the clock skew between the systems —
// if the scheduler runs ahead, stale (out-of-order) scheduler updates can
// win; if it lags, genuinely fresh ones can be wrongly skipped.
//
// Decision: compare on the SCHEDULER's own clock whenever we can, falling back
// to wall-clock only for rows a human edited locally:
//
//   • Row last written BY the scheduler (`syncSource === 'scheduler'`):
//     `externalUpdatedAt` holds the scheduler timestamp of that last write —
//     i.e. the SAME clock as the incoming payload. Apply iff the incoming
//     timestamp is strictly newer. This is the common case (repeated pulls,
//     reconciliation, out-of-order webhook delivery) and is fully immune to
//     clock skew, since both sides of the comparison come from the scheduler.
//
//   • Row last written LOCALLY (`syncSource === 'local'`, or no scheduler
//     timestamp recorded yet): a genuine SecureOps edit owns the row and we
//     have no scheduler-clock reference for that edit. Fall back to the
//     wall-clock comparison and let SecureOps win ties within a 1 s grace
//     window, so only a scheduler change that is clearly newer overrides a
//     local edit ("local edits win unless genuinely superseded").
// -------------------------------------------------------------------------
const LOCAL_EDIT_TIE_GRACE_MS = 1000;

export function shouldApplyInboundUpdate(
  existing: { syncSource: string; externalUpdatedAt: Date | string | null; updatedAt: Date | string },
  incomingUpdatedAt: Date,
): { apply: boolean; reason?: string } {
  // Scheduler-vs-scheduler: apples-to-apples on the scheduler's own clock.
  if (existing.syncSource === SCHEDULER_SOURCE && existing.externalUpdatedAt != null) {
    const lastSchedulerTs = new Date(existing.externalUpdatedAt).getTime();
    if (incomingUpdatedAt.getTime() > lastSchedulerTs) {
      return { apply: true };
    }
    return {
      apply: false,
      reason: "incoming is not newer than last synced scheduler timestamp (externalUpdatedAt)",
    };
  }

  // Local edit owns the row: wall-clock comparison, SecureOps wins ties.
  const localUpdatedAt = new Date(existing.updatedAt).getTime();
  if (incomingUpdatedAt.getTime() - localUpdatedAt > LOCAL_EDIT_TIE_GRACE_MS) {
    return { apply: true };
  }
  return {
    apply: false,
    reason: "local edit is same age or newer (SecureOps wins tiebreaker)",
  };
}

/**
 * Process a single inbound shift payload (upsert or delete).
 * Used by both the webhook handler and the reconciliation job.
 */
export async function processInboundShift(payload: SchedulerShiftPayload): Promise<{
  action: "created" | "updated" | "deleted" | "skipped";
  secureopsId?: string;
  skipReason?: string;
}> {
  const incomingUpdatedAt = new Date(payload.updatedAt);

  if (payload.deleted) {
    // Delete by externalId
    const [existing] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(and(
        eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
        eq(shiftsTable.externalId, payload.id),
      ))
      .limit(1);
    if (!existing) return { action: "skipped", skipReason: "not found" };
    await db.delete(shiftsTable).where(eq(shiftsTable.id, existing.id));
    return { action: "deleted", secureopsId: existing.id };
  }

  const siteId = await resolveSiteByName(payload.siteName);

  // Find existing row by externalId
  const [existing] = await db
    .select()
    .from(shiftsTable)
    .where(and(
      eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
      eq(shiftsTable.externalId, payload.id),
    ))
    .limit(1);

  if (existing) {
    // Last-write-wins conflict resolution — see `shouldApplyInboundUpdate`.
    const decision = shouldApplyInboundUpdate(existing, incomingUpdatedAt);
    if (!decision.apply) {
      return { action: "skipped", secureopsId: existing.id, skipReason: decision.reason };
    }

    // Reject malformed external windows (NaN, end<=start, >24h) — a multi-day
    // shift from the scheduler poisons overlap/clock-in exactly like a local
    // one. Quarantine rather than ingest: skip with a reason that surfaces in
    // the webhook response + logs so operators can fix it upstream.
    {
      const effStart = payload.startTime ? new Date(payload.startTime) : new Date(existing.startTime);
      const effEnd = payload.endTime ? new Date(payload.endTime) : new Date(existing.endTime);
      const w = validateShiftWindow(effStart, effEnd);
      if (!w.ok) {
        logger.warn({ externalId: payload.id, secureopsId: existing.id, reason: w.message }, "[scheduler] skipped inbound shift update: invalid window");
        return { action: "skipped", secureopsId: existing.id, skipReason: w.message };
      }
    }

    const lvl = typeof payload.requiredLicenseLevel === "number"
      ? ([1, 2, 3, 4].includes(payload.requiredLicenseLevel) ? payload.requiredLicenseLevel : existing.requiredLicenseLevel)
      : existing.requiredLicenseLevel;

    await db.update(shiftsTable).set({
      title: payload.title ?? existing.title,
      siteId: siteId ?? existing.siteId,
      startTime: payload.startTime ? new Date(payload.startTime) : existing.startTime,
      endTime: payload.endTime ? new Date(payload.endTime) : existing.endTime,
      payRate: payload.payRate != null ? String(payload.payRate) : existing.payRate,
      billRate: payload.billRate != null ? String(payload.billRate) : existing.billRate,
      hourlyRate: payload.payRate != null ? String(payload.payRate) : existing.hourlyRate,
      requiredLicenseLevel: lvl,
      headcount: typeof payload.headcount === "number" ? Math.max(1, payload.headcount) : existing.headcount,
      status: payload.status ?? existing.status,
      notes: payload.notes !== undefined ? payload.notes : existing.notes,
      externalUpdatedAt: incomingUpdatedAt,
      syncSource: SCHEDULER_SOURCE,
    }).where(eq(shiftsTable.id, existing.id));

    // Reconcile the officer roster when the scheduler supplied one. An omitted
    // field means "no roster info in this payload" — leave assignments untouched.
    if (payload.assignedOfficerEmails !== undefined) {
      await reconcileShiftRoster(existing.id, payload.assignedOfficerEmails);
    }

    return { action: "updated", secureopsId: existing.id };
  }

  // Create new shift
  if (!payload.title || !payload.startTime || !payload.endTime) {
    return { action: "skipped", skipReason: "missing required fields (title, startTime, endTime)" };
  }

  // Same window guard as the update path — never ingest a multi-day / inverted
  // shift from the scheduler.
  {
    const w = validateShiftWindow(new Date(payload.startTime), new Date(payload.endTime));
    if (!w.ok) {
      logger.warn({ externalId: payload.id, reason: w.message }, "[scheduler] skipped inbound shift create: invalid window");
      return { action: "skipped", skipReason: w.message };
    }
  }

  const lvl = typeof payload.requiredLicenseLevel === "number"
    ? ([1, 2, 3, 4].includes(payload.requiredLicenseLevel) ? payload.requiredLicenseLevel : 2)
    : 2;
  const hc = typeof payload.headcount === "number" ? Math.max(1, payload.headcount) : 1;
  const pay = payload.payRate ?? "0";
  const bill = payload.billRate ?? "0";

  // ON CONFLICT DO UPDATE makes the insert atomic against concurrent webhook/reconcile
  // calls for the same externalId — the unique constraint on (externalSource, externalId)
  // guarantees only one row is created even under parallel processing.
  const [created] = await db.insert(shiftsTable).values({
    title: payload.title,
    siteId: siteId ?? null,
    startTime: new Date(payload.startTime),
    endTime: new Date(payload.endTime),
    payRate: String(pay),
    billRate: String(bill),
    hourlyRate: String(pay),
    status: payload.status ?? "upcoming",
    requiredLicenseLevel: lvl,
    headcount: hc,
    notes: payload.notes ?? null,
    externalId: payload.id,
    externalSource: SCHEDULER_SOURCE,
    externalUpdatedAt: incomingUpdatedAt,
    syncSource: SCHEDULER_SOURCE,
  })
  .onConflictDoUpdate({
    target: [shiftsTable.externalSource, shiftsTable.externalId],
    set: {
      title: payload.title,
      siteId: siteId ?? null,
      startTime: new Date(payload.startTime),
      endTime: new Date(payload.endTime),
      payRate: String(pay),
      billRate: String(bill),
      hourlyRate: String(pay),
      status: payload.status ?? "upcoming",
      requiredLicenseLevel: lvl,
      headcount: hc,
      notes: payload.notes ?? null,
      externalUpdatedAt: incomingUpdatedAt,
      syncSource: SCHEDULER_SOURCE,
    },
  })
  .returning();

  // Reconcile the officer roster when the scheduler supplied one. An omitted
  // field means "no roster info in this payload" — leave assignments untouched.
  if (payload.assignedOfficerEmails !== undefined) {
    await reconcileShiftRoster(created.id, payload.assignedOfficerEmails);
  }

  return { action: "created", secureopsId: created.id };
}

/**
 * Process a single inbound clock-event payload (upsert or delete).
 * Used by both the webhook handler and the reconciliation job.
 */
export async function processInboundClockEvent(payload: SchedulerClockEventPayload & { action?: "upsert" | "delete" }): Promise<{
  action: "created" | "updated" | "deleted" | "skipped";
  secureopsId?: string;
  mergedExisting?: boolean;
  skipReason?: string;
}> {
  const incomingUpdatedAt = new Date(payload.updatedAt);
  const isDelete = (payload as any).action === "delete";

  if (isDelete) {
    const [existing] = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(and(
        eq(timeEntriesTable.externalSource, SCHEDULER_SOURCE),
        eq(timeEntriesTable.externalId, payload.id),
      ))
      .limit(1);
    if (!existing) return { action: "skipped", skipReason: "not found" };
    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, existing.id));
    return { action: "deleted", secureopsId: existing.id };
  }

  if (!payload.employeeEmail || !payload.clockInTime) {
    return { action: "skipped", skipReason: "missing required fields (employeeEmail, clockInTime)" };
  }

  const employeeId = await resolveUserByEmail(payload.employeeEmail);
  if (!employeeId) {
    return { action: "skipped", skipReason: `officer not found by email: ${payload.employeeEmail}` };
  }

  const siteId = await resolveSiteByName(payload.siteName);
  const shiftId = payload.shiftId ? await resolveShiftByExternalId(payload.shiftId) : null;
  const clockIn = new Date(payload.clockInTime);
  const clockOut = payload.clockOutTime ? new Date(payload.clockOutTime) : null;
  const hours = clockOut ? String(Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100) : null;

  // 1. Match by externalId first
  const [byExternal] = await db
    .select()
    .from(timeEntriesTable)
    .where(and(
      eq(timeEntriesTable.externalSource, SCHEDULER_SOURCE),
      eq(timeEntriesTable.externalId, payload.id),
    ))
    .limit(1);

  if (byExternal) {
    // Last-write-wins conflict resolution — see `shouldApplyInboundUpdate`.
    const decision = shouldApplyInboundUpdate(byExternal, incomingUpdatedAt);
    if (!decision.apply) {
      return { action: "skipped", secureopsId: byExternal.id, skipReason: decision.reason };
    }
    await db.update(timeEntriesTable).set({
      clockOutTime: clockOut ?? byExternal.clockOutTime,
      hoursWorked: hours ?? byExternal.hoursWorked,
      shiftId: shiftId ?? byExternal.shiftId,
      siteId: siteId ?? byExternal.siteId,
      externalUpdatedAt: incomingUpdatedAt,
      syncSource: SCHEDULER_SOURCE,
    }).where(eq(timeEntriesTable.id, byExternal.id));
    return { action: "updated", secureopsId: byExternal.id, mergedExisting: false };
  }

  // 2. Deduplication by officer + site/shift + clock-in within ±5 min tolerance
  const lowerBound = new Date(clockIn.getTime() - DEDUP_TOLERANCE_MS);
  const upperBound = new Date(clockIn.getTime() + DEDUP_TOLERANCE_MS);

  const dupConds = [
    eq(timeEntriesTable.employeeId, employeeId),
    gte(timeEntriesTable.clockInTime, lowerBound),
    lte(timeEntriesTable.clockInTime, upperBound),
  ];
  if (shiftId) {
    dupConds.push(eq(timeEntriesTable.shiftId, shiftId));
  } else if (siteId) {
    const siteOrClause = or(
      eq(timeEntriesTable.siteId, siteId),
      sql`${timeEntriesTable.shiftId} IN (SELECT id FROM shifts WHERE site_id = ${siteId}::uuid)`,
    );
    if (siteOrClause) dupConds.push(siteOrClause);
  }

  const [nearMatch] = await db
    .select()
    .from(timeEntriesTable)
    .where(and(...dupConds))
    .limit(1);

  if (nearMatch) {
    // Last-write-wins conflict resolution — same intent as the external-ID path
    // above. This is the FIRST time we'd link this inbound scheduler event to a
    // pre-existing local clock-in (the local row has no externalId yet, so its
    // syncSource is 'local' and `shouldApplyInboundUpdate` falls through to the
    // wall-clock "local edits win ties" branch). A late / out-of-order scheduler
    // event must NOT stamp its external ID + partial data onto a local entry the
    // officer has since updated locally (e.g. a real clock-out / hours edit).
    const decision = shouldApplyInboundUpdate(nearMatch, incomingUpdatedAt);
    if (!decision.apply) {
      return { action: "skipped", secureopsId: nearMatch.id, mergedExisting: false, skipReason: decision.reason };
    }
    // Merge: update the existing entry with the external ID + any missing data.
    // Local non-null values still take precedence (the local clock-in is
    // authoritative for its own data); the scheduler event only fills the gaps.
    await db.update(timeEntriesTable).set({
      externalId: payload.id,
      externalSource: SCHEDULER_SOURCE,
      externalUpdatedAt: incomingUpdatedAt,
      clockOutTime: nearMatch.clockOutTime ?? clockOut ?? null,
      hoursWorked: nearMatch.hoursWorked ?? hours ?? null,
      shiftId: nearMatch.shiftId ?? shiftId ?? null,
      siteId: nearMatch.siteId ?? siteId ?? null,
    }).where(eq(timeEntriesTable.id, nearMatch.id));
    return { action: "updated", secureopsId: nearMatch.id, mergedExisting: true };
  }

  // 3. Create new time entry.
  // ON CONFLICT DO UPDATE handles concurrent webhook/reconcile races on the same
  // externalId — the unique constraint on (externalSource, externalId) ensures
  // only one row is created even if two callers race past the lookups above.
  const [created] = await db.insert(timeEntriesTable).values({
    employeeId,
    shiftId: shiftId ?? null,
    siteId: siteId ?? null,
    clockInTime: clockIn,
    clockOutTime: clockOut ?? null,
    hoursWorked: hours ?? null,
    approvalStatus: "pending",
    isVerified: false,
    externalId: payload.id,
    externalSource: SCHEDULER_SOURCE,
    externalUpdatedAt: incomingUpdatedAt,
    syncSource: SCHEDULER_SOURCE,
  })
  .onConflictDoUpdate({
    target: [timeEntriesTable.externalSource, timeEntriesTable.externalId],
    set: {
      shiftId: shiftId ?? null,
      siteId: siteId ?? null,
      clockInTime: clockIn,
      clockOutTime: clockOut ?? null,
      hoursWorked: hours ?? null,
      externalUpdatedAt: incomingUpdatedAt,
      syncSource: SCHEDULER_SOURCE,
    },
  })
  .returning();

  return { action: "created", secureopsId: created.id, mergedExisting: false };
}

/**
 * Bulk-process a delta of shifts and clock events from the scheduler.
 * Returns counts of each outcome. Used by both the webhook and the
 * scheduled reconciliation job.
 */
export async function reconcileSchedulerDelta(
  shifts: SchedulerShiftPayload[],
  clockEvents: SchedulerClockEventPayload[],
): Promise<{
  shiftsCreated: number; shiftsUpdated: number; shiftsDeleted: number; shiftsSkipped: number;
  eventsCreated: number; eventsUpdated: number; eventsDeleted: number; eventsSkipped: number;
}> {
  const counts = {
    shiftsCreated: 0, shiftsUpdated: 0, shiftsDeleted: 0, shiftsSkipped: 0,
    eventsCreated: 0, eventsUpdated: 0, eventsDeleted: 0, eventsSkipped: 0,
  };

  for (const s of shifts) {
    const r = await processInboundShift(s);
    if (r.action === "created") counts.shiftsCreated++;
    else if (r.action === "updated") counts.shiftsUpdated++;
    else if (r.action === "deleted") counts.shiftsDeleted++;
    else counts.shiftsSkipped++;
  }

  for (const e of clockEvents) {
    const r = await processInboundClockEvent(e);
    if (r.action === "created") counts.eventsCreated++;
    else if (r.action === "updated") counts.eventsUpdated++;
    else if (r.action === "deleted") counts.eventsDeleted++;
    else counts.eventsSkipped++;
  }

  return counts;
}

// -------------------------------------------------------------------------
// Route: POST /scheduler-webhook/shifts
// -------------------------------------------------------------------------
router.post("/scheduler-webhook/shifts", webhookLimiter, requireHmac, async (req: Request, res: Response): Promise<void> => {
  const parse = InboundShiftSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Bad Request", message: "Invalid payload", issues: parse.error.issues });
    return;
  }
  const payload = parse.data as InboundShift;

  // Convert to the canonical SchedulerShiftPayload shape.
  // title/startTime/endTime are optional in the Zod schema (to allow partial
  // updates), but SchedulerShiftPayload only makes them truly optional — the
  // processInboundShift function validates that they're present for creates.
  // Officer-roster reconciliation against `assignedOfficerEmails` is handled
  // inside `processInboundShift` (shared with the scheduled reconciliation job),
  // so a roster change syncs the same way whether it arrives by webhook or the
  // periodic delta pull. The scheduler is authoritative for the roster: a
  // present list is the FULL set of assigned officers (omitted = leave untouched,
  // empty array = clear). Reconciliation only runs on "created"/"updated"; a
  // "skipped" stale-payload result leaves the roster alone and "deleted"
  // cascades assignments away.
  const canonical: SchedulerShiftPayload = {
    id: payload.id,
    title: payload.title ?? undefined,
    siteName: payload.siteName,
    startTime: payload.startTime ?? undefined,
    endTime: payload.endTime ?? undefined,
    payRate: payload.payRate,
    billRate: payload.billRate,
    requiredLicenseLevel: payload.requiredLicenseLevel,
    headcount: payload.headcount,
    status: payload.status,
    notes: payload.notes,
    assignedOfficerEmails: payload.assignedOfficerEmails,
    updatedAt: payload.updatedAt,
    deleted: payload.action === "delete",
  };

  const result = await processInboundShift(canonical);

  res.json({ ok: true, ...result });
});

// -------------------------------------------------------------------------
// Route: POST /scheduler-webhook/clock-events
// -------------------------------------------------------------------------
router.post("/scheduler-webhook/clock-events", webhookLimiter, requireHmac, async (req: Request, res: Response): Promise<void> => {
  const parse = InboundClockEventSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Bad Request", message: "Invalid payload", issues: parse.error.issues });
    return;
  }
  const payload = parse.data as InboundClockEvent;

  const canonical: SchedulerClockEventPayload & { action?: "upsert" | "delete" } = {
    id: payload.id,
    action: payload.action,
    employeeEmail: payload.employeeEmail ?? "",
    shiftId: payload.shiftId,
    siteName: payload.siteName,
    clockInTime: payload.clockInTime ?? "",
    clockOutTime: payload.clockOutTime,
    hoursWorked: payload.hoursWorked,
    updatedAt: payload.updatedAt,
  };

  const result = await processInboundClockEvent(canonical);
  res.json({ ok: true, ...result });
});

export default router;
