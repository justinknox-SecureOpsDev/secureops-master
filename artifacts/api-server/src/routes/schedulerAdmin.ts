/**
 * Admin API for the Event Staff Scheduler integration.
 *
 * GET  /admin/scheduler/status   — connection config + last-sync health
 * POST /admin/scheduler/test     — test connectivity to the scheduler
 * POST /admin/scheduler/resync   — trigger an immediate reconciliation pull
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, schedulerSyncCursorsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import {
  isSchedulerConfigured,
  testSchedulerConnection,
  fetchSchedulerDelta,
  forwardToScheduler,
  type SchedulerProxyResult,
} from "../lib/schedulerSync";
import { reconcileSchedulerDelta } from "./schedulerWebhook";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Event-management proxy
//
// The admin portal cannot hold the scheduler's shared HMAC secret, so it can
// never sign requests to the scheduler directly. Instead it authenticates to
// THIS API with its admin JWT (requireAdmin), and we sign + forward the call
// to the scheduler on its behalf. Each handler relays the scheduler's status
// code and body verbatim, and surfaces a clear 503 when the integration is
// not configured (rather than letting the portal see a raw auth error).
// ---------------------------------------------------------------------------

/**
 * Relay a `forwardToScheduler` result back to the portal. Handles the
 * not-configured (null) case as a friendly 503 and network failures as 502.
 */
async function relayToScheduler(
  res: Response,
  run: () => Promise<SchedulerProxyResult | null>,
): Promise<void> {
  let result: SchedulerProxyResult | null;
  try {
    result = await run();
  } catch (err) {
    logger.warn({ err }, "[schedulerAdmin] proxy request to scheduler failed");
    res.status(502).json({
      error: "Bad Gateway",
      message: "Could not reach the Event Staff Scheduler. Please try again.",
    });
    return;
  }

  if (result === null) {
    res.status(503).json({
      error: "Service Unavailable",
      message: "Scheduler integration not configured",
    });
    return;
  }

  // Do NOT relay a downstream 401/403 verbatim. The portal's generic api() /
  // fetchWithAuth helpers treat ANY token-carrying 401 as "the admin session
  // expired" and force a logout/redirect. But a 401/403 here means the SCHEDULER
  // rejected our forwarded (HMAC-signed) request — most likely a shared-secret
  // mismatch or the scheduler's own auth failing — NOT that the admin's portal
  // session is invalid. Remap it to a 502 with a clear integration error so the
  // admin stays logged in and sees an actionable message instead of being
  // bounced to the login screen. All other statuses (2xx/400/404/409/…) relay
  // verbatim.
  if (result.status === 401 || result.status === 403) {
    logger.warn(
      { status: result.status },
      "[schedulerAdmin] scheduler rejected the forwarded request (auth failure)",
    );
    res.status(502).json({
      error: "Bad Gateway",
      message:
        "The scheduler rejected the request — the integration may be misconfigured. Check the shared secret.",
    });
    return;
  }

  res.status(result.status).json(result.body ?? null);
}

function eventId(req: Request): string {
  return encodeURIComponent(String(req.params.id));
}

// List events
router.get("/admin/scheduler/events", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("GET", "/api/events"));
});

// Create event
router.post("/admin/scheduler/events", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("POST", "/api/events", { body: req.body }));
});

// Get full event (event + shifts + signups)
router.get("/admin/scheduler/events/:id/full", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("GET", `/api/events/${eventId(req)}/full`));
});

// Get event coverage stats
router.get("/admin/scheduler/events/:id/stats", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("GET", `/api/events/${eventId(req)}/stats`));
});

// Update event
router.patch("/admin/scheduler/events/:id", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("PATCH", `/api/events/${eventId(req)}`, { body: req.body }));
});

// Delete event
router.delete("/admin/scheduler/events/:id", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("DELETE", `/api/events/${eventId(req)}`));
});

// Add a shift to an event
router.post("/admin/scheduler/events/:id/shifts", requireAdmin, async (req, res): Promise<void> => {
  await relayToScheduler(res, () => forwardToScheduler("POST", `/api/events/${eventId(req)}/shifts`, { body: req.body }));
});

// Delete a signup (name passed through as a query param)
router.delete("/admin/scheduler/signups/:id", requireAdmin, async (req, res): Promise<void> => {
  const sid = encodeURIComponent(String(req.params.id));
  const rawName = req.query.name;
  const name = Array.isArray(rawName) ? String(rawName[0]) : typeof rawName === "string" ? rawName : undefined;
  await relayToScheduler(res, () =>
    forwardToScheduler("DELETE", `/api/signups/${sid}`, { query: { name } }),
  );
});

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
