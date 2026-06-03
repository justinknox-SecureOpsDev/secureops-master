/**
 * Admin API for the Event Staff Scheduler integration.
 *
 * GET  /admin/scheduler/status   — connection config + last-sync health
 * POST /admin/scheduler/test     — test connectivity to the scheduler
 * POST /admin/scheduler/resync   — trigger an immediate reconciliation pull
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schedulerSyncCursorsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { isSchedulerConfigured, testSchedulerConnection, fetchSchedulerDelta } from "../lib/schedulerSync";
import { reconcileSchedulerDelta } from "./schedulerWebhook";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/admin/scheduler/status", requireAdmin, async (_req, res): Promise<void> => {
  const configured = isSchedulerConfigured();

  let cursors: Array<{ cursorKey: string; cursorValue: string; lastSyncAt: Date | null; lastSyncError: string | null; lastSyncShiftsProcessed: string | null; lastSyncEventsProcessed: string | null }> = [];
  if (configured) {
    cursors = await db.select().from(schedulerSyncCursorsTable);
  }

  const shiftsCursor = cursors.find((c) => c.cursorKey === "shifts");
  // Both shift and clock-event counts are stored in the single "shifts" cursor row
  // (the only cursor key the resync job writes). The "clock_events" key is reserved
  // for future independent cursors if the scheduler API ever exposes a separate
  // clock-events delta endpoint.
  res.json({
    configured,
    baseUrl: configured ? (process.env.SCHEDULER_BASE_URL ?? "").replace(/\/$/, "") : null,
    lastSyncAt: shiftsCursor?.lastSyncAt ?? null,
    lastSyncError: shiftsCursor?.lastSyncError ?? null,
    lastSyncShiftsProcessed: shiftsCursor?.lastSyncShiftsProcessed ?? "0",
    lastSyncEventsProcessed: shiftsCursor?.lastSyncEventsProcessed ?? "0",
    shiftsCursor: shiftsCursor?.cursorValue ?? "1970-01-01T00:00:00.000Z",
    eventsCursor: shiftsCursor?.cursorValue ?? "1970-01-01T00:00:00.000Z",
  });
});

router.post("/admin/scheduler/test", requireAdmin, async (req, res): Promise<void> => {
  const result = await testSchedulerConnection();
  if (!result.ok) {
    res.status(result.statusCode ?? 503).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

router.post("/admin/scheduler/resync", requireAdmin, async (req, res): Promise<void> => {
  if (!isSchedulerConfigured()) {
    res.status(503).json({ error: "Service Unavailable", message: "Scheduler integration not configured" });
    return;
  }

  const [shiftsCursor] = await db
    .select()
    .from(schedulerSyncCursorsTable)
    .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));

  const since = shiftsCursor?.cursorValue ?? "1970-01-01T00:00:00.000Z";

  const delta = await fetchSchedulerDelta(since);
  if (!delta) {
    res.status(503).json({ error: "Service Unavailable", message: "Could not reach scheduler for delta fetch" });
    return;
  }

  let counts;
  try {
    counts = await reconcileSchedulerDelta(delta.shifts, delta.clockEvents);
  } catch (err) {
    logger.error({ err }, "[schedulerAdmin] resync reconciliation failed");
    res.status(500).json({ error: "Internal Server Error", message: "Reconciliation failed" });
    return;
  }

  const now = new Date();
  const nextCursor = delta.nextCursor ?? now.toISOString();

  // Advance cursor
  await db
    .insert(schedulerSyncCursorsTable)
    .values({
      cursorKey: "shifts",
      cursorValue: nextCursor,
      lastSyncAt: now,
      lastSyncError: null,
      lastSyncShiftsProcessed: String(counts.shiftsCreated + counts.shiftsUpdated + counts.shiftsDeleted),
      lastSyncEventsProcessed: String(counts.eventsCreated + counts.eventsUpdated + counts.eventsDeleted),
    })
    .onConflictDoUpdate({
      target: schedulerSyncCursorsTable.cursorKey,
      set: {
        cursorValue: nextCursor,
        lastSyncAt: now,
        lastSyncError: null,
        lastSyncShiftsProcessed: String(counts.shiftsCreated + counts.shiftsUpdated + counts.shiftsDeleted),
        lastSyncEventsProcessed: String(counts.eventsCreated + counts.eventsUpdated + counts.eventsDeleted),
        updatedAt: now,
      },
    });

  res.json({ ok: true, ...counts, since, nextCursor });
});

export default router;
