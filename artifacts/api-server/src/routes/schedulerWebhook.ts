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
import { eq, and, sql, gte, lte, or } from "drizzle-orm";
import { z } from "zod/v4";
import { db, shiftsTable, timeEntriesTable, usersTable, sitesTable, shiftAssignmentsTable } from "@workspace/db";
import { verifySignature, SCHEDULER_SOURCE, type SchedulerShiftPayload, type SchedulerClockEventPayload } from "../lib/schedulerSync";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

// -------------------------------------------------------------------------
// Rate limiter: 120 req / 5 min per IP — generous for legitimate webhook
// traffic, tight enough to slow down brute-force signature guessing.
// -------------------------------------------------------------------------
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
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
    // Last-write-wins conflict resolution.
    // SecureOps wins tiebreaker within 1 second: only apply incoming if it is
    // GENUINELY newer by more than 1 s. Equal or within-1 s → SecureOps wins.
    const localUpdatedAt = new Date(existing.updatedAt);
    if (incomingUpdatedAt.getTime() - localUpdatedAt.getTime() <= 1000) {
      return { action: "skipped", secureopsId: existing.id, skipReason: "local is same age or newer (SecureOps wins tiebreaker)" };
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

    return { action: "updated", secureopsId: existing.id };
  }

  // Create new shift
  if (!payload.title || !payload.startTime || !payload.endTime) {
    return { action: "skipped", skipReason: "missing required fields (title, startTime, endTime)" };
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
    // Last-write-wins — SecureOps wins tiebreaker within 1 second.
    const localUpdatedAt = new Date(byExternal.updatedAt);
    if (incomingUpdatedAt.getTime() - localUpdatedAt.getTime() <= 1000) {
      return { action: "skipped", secureopsId: byExternal.id, skipReason: "local is same age or newer (SecureOps wins tiebreaker)" };
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
    // Merge: update the existing entry with the external ID + any missing data
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
    updatedAt: payload.updatedAt,
    deleted: payload.action === "delete",
  };

  const result = await processInboundShift(canonical);

  // If there are assigned officers, create assignments for a newly created shift
  if (result.action === "created" && result.secureopsId && payload.assignedOfficerEmails?.length) {
    for (const email of payload.assignedOfficerEmails) {
      const userId = await resolveUserByEmail(email);
      if (!userId) continue;
      try {
        await db.insert(shiftAssignmentsTable).values({
          shiftId: result.secureopsId,
          employeeId: userId,
          status: "accepted",
        }).onConflictDoNothing();
      } catch {
        // ignore duplicate assignment errors
      }
    }
  }

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
