import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
  sitesTable,
  incidentsTable,
  licensesTable,
  chatRoomsTable,
  officerAvailabilityWindowsTable,
} from "@workspace/db";
import { requireAdminOrDispatcher } from "../middlewares/auth";

const router: IRouter = Router();

// Status board thresholds (minutes).
//   late     — shift started > LATE_MIN ago, no clock-in
//   noShow   — shift started > NO_SHOW_MIN ago, still no clock-in
//   earlyOut — officer clocked out and scheduled end is still
//              EARLY_OUT_MIN+ in the future
const LATE_MIN = 10;
const NO_SHOW_MIN = 60;
const EARLY_OUT_MIN = 30;

const MS_MIN = 60_000;

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * GET /dispatch/status-board
 *
 * Single roll-up the Dispatch screen uses to render the clock-in status
 * board. Window = today (00:00–24:00 in the server's local day) plus any
 * shift currently in progress, so an overnight shift that started
 * yesterday but hasn't ended still appears. Buckets:
 *
 *   onDuty   — officer has an open time_entry (clockOutTime IS NULL)
 *              for this shift
 *   late     — shift started > LATE_MIN min ago and the officer is not
 *              clocked in; degrades to noShow after NO_SHOW_MIN
 *   noShow   — shift started > NO_SHOW_MIN min ago, still no clock-in
 *   earlyOut — shift has scheduled end in future but officer already
 *              clocked out EARLY_OUT_MIN+ before end
 *   scheduled — accepted assignment that is upcoming and not yet due
 *
 * Bucketing is derived server-side so the UI never has to reason about
 * timestamps; each row carries the shift, site, and officer identity.
 */
router.get("/dispatch/status-board", requireAdminOrDispatcher, async (_req, res): Promise<void> => {
  const now = new Date();
  // "Today" window: start-of-day → start-of-tomorrow. Anything still
  // open past midnight (endTime >= now) is also pulled in so overnight
  // shifts don't drop off the board at 00:00.
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * MS_MIN);

  const rows = await db
    .select({
      assignmentId: shiftAssignmentsTable.id,
      shiftId: shiftsTable.id,
      shiftTitle: shiftsTable.title,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      siteId: shiftsTable.siteId,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      lastLat: usersTable.lastLat,
      lastLng: usersTable.lastLng,
      lastLocationAt: usersTable.lastLocationAt,
    })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .innerJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id))
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .where(and(
      eq(shiftAssignmentsTable.status, "accepted"),
      // Either the shift starts today, or it's currently running
      // (started earlier and not yet ended).
      or(
        and(gte(shiftsTable.startTime, startOfDay), lte(shiftsTable.startTime, endOfDay)),
        and(lte(shiftsTable.startTime, now), gte(shiftsTable.endTime, now)),
      ),
    ))
    .orderBy(asc(shiftsTable.startTime));

  const windowStart = new Date(Math.min(startOfDay.getTime(), now.getTime() - 8 * 60 * MS_MIN));

  // One pass through open time entries for officers in our window — used
  // to detect on-duty and early-out without round-tripping per row.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const shiftIds = [...new Set(rows.map((r) => r.shiftId))];
  const openByShift = new Map<string, { id: string; clockInTime: Date; userId: string }>();
  const closedByShift = new Map<string, { clockOutTime: Date; userId: string }>();
  if (userIds.length > 0 && shiftIds.length > 0) {
    const entries = await db
      .select({
        id: timeEntriesTable.id,
        userId: timeEntriesTable.employeeId,
        shiftId: timeEntriesTable.shiftId,
        clockInTime: timeEntriesTable.clockInTime,
        clockOutTime: timeEntriesTable.clockOutTime,
      })
      .from(timeEntriesTable)
      .where(and(
        gte(timeEntriesTable.clockInTime, windowStart),
      ));
    for (const e of entries) {
      if (!e.shiftId) continue;
      if (e.clockOutTime == null) {
        openByShift.set(`${e.shiftId}:${e.userId}`, {
          id: e.id, clockInTime: e.clockInTime, userId: e.userId,
        });
      } else {
        // Keep the latest closed entry per (shift,user)
        const k = `${e.shiftId}:${e.userId}`;
        const prev = closedByShift.get(k);
        if (!prev || e.clockOutTime > prev.clockOutTime) {
          closedByShift.set(k, { clockOutTime: e.clockOutTime, userId: e.userId });
        }
      }
    }
  }

  const buckets = {
    onDuty: [] as unknown[],
    late: [] as unknown[],
    noShow: [] as unknown[],
    earlyOut: [] as unknown[],
    scheduled: [] as unknown[],
  };

  for (const r of rows) {
    const key = `${r.shiftId}:${r.userId}`;
    const open = openByShift.get(key);
    const closed = closedByShift.get(key);
    const minsSinceStart = (now.getTime() - r.startTime.getTime()) / MS_MIN;
    const minsToEnd = (r.endTime.getTime() - now.getTime()) / MS_MIN;

    const base = {
      assignmentId: r.assignmentId,
      shiftId: r.shiftId,
      shiftTitle: r.shiftTitle,
      startTime: r.startTime,
      endTime: r.endTime,
      siteId: r.siteId,
      siteName: r.siteName,
      siteAddress: r.siteAddress,
      userId: r.userId,
      officerName: `${r.firstName} ${r.lastName}`,
      lastLat: r.lastLat,
      lastLng: r.lastLng,
      lastLocationAt: r.lastLocationAt,
    };

    if (open) {
      buckets.onDuty.push({ ...base, clockInTime: open.clockInTime, timeEntryId: open.id });
      continue;
    }
    if (closed && minsToEnd > EARLY_OUT_MIN) {
      buckets.earlyOut.push({
        ...base,
        clockOutTime: closed.clockOutTime,
        minutesEarly: Math.round(minsToEnd),
      });
      continue;
    }
    if (minsSinceStart > NO_SHOW_MIN) {
      buckets.noShow.push({ ...base, minutesLate: Math.round(minsSinceStart) });
    } else if (minsSinceStart > LATE_MIN) {
      buckets.late.push({ ...base, minutesLate: Math.round(minsSinceStart) });
    } else {
      buckets.scheduled.push({ ...base });
    }
  }

  res.json(buckets);
});

/**
 * GET /dispatch/open-shifts?hours=72
 *
 * Open shifts in the next N hours (default 72, cap 168). "Open" =
 * accepted-assignment count is below the shift's headcount. Each row
 * includes the gap so the UI can show "2 of 3 filled".
 */
router.get("/dispatch/open-shifts", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const hoursRaw = parseInt(String(req.query.hours ?? "72"), 10);
  const hours = Math.min(168, Math.max(1, Number.isFinite(hoursRaw) ? hoursRaw : 72));
  const now = new Date();
  const horizon = new Date(now.getTime() + hours * 60 * MS_MIN);

  const rows = await db
    .select({
      id: shiftsTable.id,
      title: shiftsTable.title,
      siteId: shiftsTable.siteId,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
      siteLat: sitesTable.locationLat,
      siteLng: sitesTable.locationLng,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      headcount: shiftsTable.headcount,
      requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
      payRate: shiftsTable.payRate,
      filled: sql<number>`(
        SELECT count(*)::int FROM ${shiftAssignmentsTable}
        WHERE ${shiftAssignmentsTable.shiftId} = ${shiftsTable.id}
          AND ${shiftAssignmentsTable.status} = 'accepted'
      )`,
    })
    .from(shiftsTable)
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .where(and(
      gte(shiftsTable.startTime, now),
      lte(shiftsTable.startTime, horizon),
      ne(shiftsTable.status, "cancelled"),
    ))
    .orderBy(asc(shiftsTable.startTime));

  const open = rows.filter((r) => r.filled < r.headcount);
  res.json(open);
});

/**
 * POST /dispatch/assign-nearest { shiftId, dryRun? }
 *
 * Rank qualified active officers by distance from the shift's site
 * (haversine over `users.lastLat/Lng`, falling back to the officer with
 * the most recent location ping when coords are missing) and either
 * return the ranked candidates (`dryRun=true`) or assign the top
 * candidate. Qualification: max unexpired license level meets the
 * shift's `requiredLicenseLevel`, and the officer is not already
 * accepted on this shift.
 *
 * Auto-assignment writes through the existing shift_assignments path
 * (no over-fill: re-checks filled<headcount). Idempotent — if the top
 * candidate is already assigned (race), returns 409 + the rank list so
 * the UI can pick the next.
 */
router.post("/dispatch/assign-nearest", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const { shiftId, dryRun } = (req.body ?? {}) as { shiftId?: string; dryRun?: boolean };
  if (!shiftId) {
    res.status(400).json({ error: "Bad Request", message: "shiftId required" });
    return;
  }

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId)).limit(1);
  if (!shift) { res.status(404).json({ error: "Not Found", message: "Shift not found" }); return; }

  const site = shift.siteId
    ? (await db.select().from(sitesTable).where(eq(sitesTable.id, shift.siteId)).limit(1))[0]
    : null;

  const siteLat = site?.locationLat
    ? parseFloat(site.locationLat)
    : shift.locationLat ? parseFloat(shift.locationLat) : null;
  const siteLng = site?.locationLng
    ? parseFloat(site.locationLng)
    : shift.locationLng ? parseFloat(shift.locationLng) : null;

  // Qualified active employees:
  //   - role=employee, status=active
  //   - max unexpired license level >= required
  //   - not already accepted/pending on THIS shift
  //   - NOT already accepted on another shift whose time window
  //     overlaps this shift (auto-assignment must not double-book)
  const qualified = await db
    .select({
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      lastLat: usersTable.lastLat,
      lastLng: usersTable.lastLng,
      lastLocationAt: usersTable.lastLocationAt,
      maxLevel: sql<number | null>`(
        SELECT MAX(${licensesTable.level})::int
        FROM ${licensesTable}
        WHERE ${licensesTable.employeeId} = ${usersTable.id}
          AND ${licensesTable.expiryDate} >= current_date
      )`,
      alreadyAssigned: sql<boolean>`EXISTS (
        SELECT 1 FROM ${shiftAssignmentsTable}
        WHERE ${shiftAssignmentsTable.shiftId} = ${shiftId}
          AND ${shiftAssignmentsTable.employeeId} = ${usersTable.id}
          AND ${shiftAssignmentsTable.status} IN ('accepted','pending')
      )`,
      conflictingShift: sql<boolean>`EXISTS (
        SELECT 1
          FROM ${shiftAssignmentsTable} sa2
          JOIN ${shiftsTable} s2 ON s2.id = sa2.shift_id
         WHERE sa2.employee_id = ${usersTable.id}
           AND sa2.status = 'accepted'
           AND s2.id <> ${shiftId}
           AND s2.start_time < ${shift.endTime}
           AND s2.end_time   > ${shift.startTime}
      )`,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.role, "employee"),
      eq(usersTable.status, "active"),
    ));

  // Weekly availability check: officer is available iff they have at
  // least one declared availability window on the shift's day-of-week
  // whose time-of-day range fully covers the shift's start..end. If the
  // officer has NO declared windows at all, treat them as available
  // (back-compat — many existing employees never filled this in). Only
  // officers with ≥1 declared window are subject to the constraint.
  const shiftStart = new Date(shift.startTime);
  const shiftEnd = new Date(shift.endTime);
  const dow = shiftStart.getUTCDay();
  const startHHMM = `${String(shiftStart.getUTCHours()).padStart(2, "0")}:${String(shiftStart.getUTCMinutes()).padStart(2, "0")}`;
  const endHHMM = `${String(shiftEnd.getUTCHours()).padStart(2, "0")}:${String(shiftEnd.getUTCMinutes()).padStart(2, "0")}`;
  const qualifiedIds = qualified.map((q) => q.userId);
  const availabilityByUser = new Map<string, { hasAny: boolean; covers: boolean }>();
  if (qualifiedIds.length > 0) {
    const windows = await db
      .select({
        userId: officerAvailabilityWindowsTable.userId,
        dayOfWeek: officerAvailabilityWindowsTable.dayOfWeek,
        startTime: officerAvailabilityWindowsTable.startTime,
        endTime: officerAvailabilityWindowsTable.endTime,
      })
      .from(officerAvailabilityWindowsTable)
      .where(inArray(officerAvailabilityWindowsTable.userId, qualifiedIds));
    for (const w of windows) {
      const slot = availabilityByUser.get(w.userId) ?? { hasAny: false, covers: false };
      slot.hasAny = true;
      if (w.dayOfWeek === dow && w.startTime <= startHHMM && w.endTime >= endHHMM) {
        slot.covers = true;
      }
      availabilityByUser.set(w.userId, slot);
    }
  }

  type Candidate = {
    userId: string;
    name: string;
    distanceMiles: number | null;
    lastLocationAt: Date | null;
    maxLicenseLevel: number | null;
    alreadyAssigned: boolean;
    conflictingShift: boolean;
    availabilityKnown: boolean;
    availabilityCovers: boolean;
  };
  const candidates: Candidate[] = qualified
    .filter((q) => (q.maxLevel ?? 0) >= shift.requiredLicenseLevel)
    .map((q) => {
      const lat = q.lastLat ? parseFloat(q.lastLat) : null;
      const lng = q.lastLng ? parseFloat(q.lastLng) : null;
      const distance = (siteLat !== null && siteLng !== null && lat !== null && lng !== null)
        ? haversineMiles(siteLat, siteLng, lat, lng)
        : null;
      const a = availabilityByUser.get(q.userId);
      return {
        userId: q.userId,
        name: `${q.firstName} ${q.lastName}`,
        distanceMiles: distance,
        lastLocationAt: q.lastLocationAt,
        maxLicenseLevel: q.maxLevel,
        alreadyAssigned: q.alreadyAssigned,
        conflictingShift: q.conflictingShift,
        availabilityKnown: a?.hasAny ?? false,
        availabilityCovers: a?.covers ?? false,
      };
    })
    .sort((a, b) => {
      // Hard-deprioritize already-assigned / conflicting / unavailable
      // candidates: they remain visible in the response (so the UI can
      // explain why someone is missing) but are pushed to the bottom
      // and excluded from the auto-pick.
      const aBad = a.alreadyAssigned || a.conflictingShift || (a.availabilityKnown && !a.availabilityCovers);
      const bBad = b.alreadyAssigned || b.conflictingShift || (b.availabilityKnown && !b.availabilityCovers);
      if (aBad !== bBad) return aBad ? 1 : -1;
      const da = a.distanceMiles ?? Number.POSITIVE_INFINITY;
      const db_ = b.distanceMiles ?? Number.POSITIVE_INFINITY;
      if (da !== db_) return da - db_;
      const ta = a.lastLocationAt ? a.lastLocationAt.getTime() : 0;
      const tb = b.lastLocationAt ? b.lastLocationAt.getTime() : 0;
      return tb - ta;
    });

  const isEligible = (c: Candidate) =>
    !c.alreadyAssigned &&
    !c.conflictingShift &&
    (!c.availabilityKnown || c.availabilityCovers);
  const top = candidates.find(isEligible) ?? null;

  if (dryRun || !top) {
    res.json({
      siteHasCoords: siteLat !== null && siteLng !== null,
      candidates: candidates.slice(0, 20),
      topCandidate: top,
    });
    return;
  }

  // Atomic assign with headcount re-check.
  const result = await db.transaction(async (tx) => {
    const filledRows = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(shiftAssignmentsTable)
      .where(and(
        eq(shiftAssignmentsTable.shiftId, shiftId),
        eq(shiftAssignmentsTable.status, "accepted"),
      ));
    const filled = filledRows[0]?.c ?? 0;
    if (filled >= shift.headcount) {
      return { ok: false as const, code: 409, msg: "Shift is already full" };
    }
    const [assignment] = await tx
      .insert(shiftAssignmentsTable)
      .values({ shiftId, employeeId: top.userId, status: "accepted" })
      .returning();
    return { ok: true as const, assignment };
  });

  if (!result.ok) {
    res.status(result.code).json({
      error: "Conflict",
      message: result.msg,
      candidates: candidates.slice(0, 20),
    });
    return;
  }

  res.status(201).json({
    assignment: result.assignment,
    assignedTo: top,
    candidates: candidates.slice(0, 20),
  });
});

/**
 * GET /dispatch/active-incidents
 *
 * Open / in-progress incidents from the last 24 hours, pinned by
 * severity (critical first, then high, medium, low) and then newest
 * first. Powers the Dispatch incidents panel. Dispatcher commenting
 * goes through the existing `PUT /incidents/:id` (widened to
 * admin-or-dispatcher).
 */
router.get("/dispatch/active-incidents", requireAdminOrDispatcher, async (_req, res): Promise<void> => {
  const since = new Date(Date.now() - 24 * 60 * MS_MIN);
  const rows = await db
    .select({
      id: incidentsTable.id,
      title: incidentsTable.title,
      description: incidentsTable.description,
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      lat: incidentsTable.lat,
      lng: incidentsTable.lng,
      locationDescription: incidentsTable.locationDescription,
      occurredAt: incidentsTable.occurredAt,
      createdAt: incidentsTable.createdAt,
      adminNotes: incidentsTable.adminNotes,
      employeeId: incidentsTable.employeeId,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(incidentsTable.employeeId, usersTable.id))
    .where(and(ne(incidentsTable.status, "closed"), gte(incidentsTable.createdAt, since)))
    .orderBy(
      // critical=0,high=1,medium=2,low=3 — keeps critical pinned at the top.
      sql`CASE ${incidentsTable.severity}
            WHEN 'critical' THEN 0 WHEN 'high' THEN 1
            WHEN 'medium'   THEN 2 WHEN 'low'  THEN 3
            ELSE 4 END`,
      desc(incidentsTable.createdAt),
    )
    .limit(50);
  res.json(rows);
});

/**
 * GET /dispatch/broadcast-rooms
 *
 * Convenience listing of rooms the dispatcher can post into from the
 * Dispatch broadcast composer. Returns announcements + ops + named
 * site/city/elite channels the caller is authorized for. Skips DMs.
 */
router.get("/dispatch/broadcast-rooms", requireAdminOrDispatcher, async (_req, res): Promise<void> => {
  // Lean implementation: surface all non-direct rooms — server-side
  // chat POST already enforces membership. This keeps the dispatcher
  // pinned to the same auth ladder as everyone else.
  const rooms = await db
    .select({
      id: chatRoomsTable.id,
      name: chatRoomsTable.name,
      type: chatRoomsTable.type,
    })
    .from(chatRoomsTable)
    .where(ne(chatRoomsTable.type, "direct"))
    .orderBy(asc(chatRoomsTable.name));
  res.json(rooms);
});

export default router;
