import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
  sitesTable,
  incidentsTable,
  licensesTable,
  employeesTable,
  chatRoomsTable,
  officerAvailabilityWindowsTable,
} from "@workspace/db";
import { requireAdmin, requireAdminOrDispatcher, requireAuth } from "../middlewares/auth";
import { requirePermission } from "../lib/permissions";

// Representative wiring for the "dispatch.manage" permission key: assigning
// an officer to the nearest open shift stays admin/dispatcher by default
// (matching requireAdminOrDispatcher exactly) but is now toggleable via the
// Permissions admin UI.
const requireDispatchManage = [requireAuth, requirePermission("dispatch.manage")] as const;
import { getGeofenceRadiusMiles } from "../lib/geofence";
import { businessDayWindow, businessTimeZone } from "../lib/businessTime";
import { requireFeature } from "../lib/features";
import { broadcastOfficerJoined } from "../lib/wsManager";
import { isOpenTimeEntryConflict } from "../lib/timeEntryConflict";

const router: IRouter = Router();
router.use("/dispatch", requireFeature("liveMap"));

/**
 * GET /dispatch/config
 *
 * Dispatcher-safe operational config. Right now this only exposes the
 * geofence radius (miles) so the Live Map can render the same circle
 * the backend uses to fire breach push/SMS. Dispatchers are blocked
 * from /admin/system/status; this endpoint is the parity-safe surface
 * for the values they legitimately need on the map.
 *
 * Returns ONLY non-secret operational tunables.
 */
router.get("/dispatch/config", requireAdminOrDispatcher, (_req, res): void => {
  res.json({
    geofenceRadiusMiles: getGeofenceRadiusMiles(),
  });
});

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
 * board. Window = today (00:00–24:00 in the BUSINESS timezone — Central by
 * default, NOT the server's UTC day) plus any shift currently in progress,
 * so an overnight shift that started yesterday but hasn't ended still
 * appears. Buckets:
 *
 *   onDuty   — officer has ANY open time_entry (clockOutTime IS NULL),
 *              i.e. they are clocked in right now. Sourced directly from
 *              open time entries (not the accepted-assignment join) so the
 *              count matches the dashboard's "clocked in now" and an officer
 *              attached to a shift outside today's window still surfaces.
 *   late     — shift started > LATE_MIN min ago and the officer is not
 *              clocked in; degrades to noShow after NO_SHOW_MIN
 *   noShow   — shift started > NO_SHOW_MIN min ago, still no clock-in
 *   earlyOut — shift has scheduled end in future but officer already
 *              clocked out EARLY_OUT_MIN+ before end
 *   completed — officer clocked in AND out and worked to (or near) the
 *              scheduled end; never counts as late / no-show
 *   scheduled — accepted assignment that is upcoming and not yet due
 *
 * Bucketing is derived server-side so the UI never has to reason about
 * timestamps; each row carries the shift, site, and officer identity.
 */
router.get("/dispatch/status-board", requireAdminOrDispatcher, async (_req, res): Promise<void> => {
  const now = new Date();
  // "Today" window: start-of-day → start-of-tomorrow, in the BUSINESS timezone
  // (Central by default, NOT the server's UTC). Anything still open past
  // midnight (endTime >= now) is also pulled in so overnight shifts don't drop
  // off the board at 00:00.
  const { startOfDay, endOfDay } = businessDayWindow(now, businessTimeZone());

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
        and(gte(shiftsTable.startTime, startOfDay), lt(shiftsTable.startTime, endOfDay)),
        and(lte(shiftsTable.startTime, now), gte(shiftsTable.endTime, now)),
      ),
    ))
    .orderBy(asc(shiftsTable.startTime));

  const windowStart = new Date(Math.min(startOfDay.getTime(), now.getTime() - 8 * 60 * MS_MIN));

  // -- onDuty: authoritative "clocked in right now" set ----------------------
  // Driven directly by OPEN time entries (clockOutTime IS NULL), NOT by the
  // accepted-assignment-in-window join above. An officer is on duty the moment
  // they clock in — regardless of whether their attached shift falls in today's
  // window (e.g. an overnight that started earlier, an officer attached to the
  // wrong shift, or an ad-hoc geo clock-in with no shift at all). Sourcing this
  // from the assignment join silently dropped those officers, so the board's
  // count diverged from the dashboard's "clocked in now". Site name falls back
  // to the time entry's own siteId when the entry has no shift.
  const openEntries = await db
    .select({
      timeEntryId: timeEntriesTable.id,
      userId: timeEntriesTable.employeeId,
      shiftId: timeEntriesTable.shiftId,
      clockInTime: timeEntriesTable.clockInTime,
      teSiteId: timeEntriesTable.siteId,
      shiftTitle: shiftsTable.title,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      shiftSiteId: shiftsTable.siteId,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      lastLat: usersTable.lastLat,
      lastLng: usersTable.lastLng,
      lastLocationAt: usersTable.lastLocationAt,
    })
    .from(timeEntriesTable)
    .innerJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(
      sitesTable,
      sql`${sitesTable.id} = coalesce(${shiftsTable.siteId}, ${timeEntriesTable.siteId})`,
    )
    .where(isNull(timeEntriesTable.clockOutTime))
    .orderBy(asc(timeEntriesTable.clockInTime));

  // An officer clocked into a shift must not ALSO surface as late / no-show /
  // scheduled for THAT same shift. We skip per (officer, shift) so a second
  // assignment later the same day still shows up. When the open entry has no
  // shift attached (ad-hoc, billing-only) we can't disambiguate which roster
  // it covers, so we fall back to skipping that officer's rows entirely to
  // avoid double-counting a clearly-present officer.
  const onDutyShiftKeys = new Set(
    openEntries.filter((e) => e.shiftId).map((e) => `${e.userId}:${e.shiftId}`),
  );
  const onDutyUsersNoShift = new Set(
    openEntries.filter((e) => !e.shiftId).map((e) => e.userId),
  );

  // Closed entries for the windowed shifts — used to classify earlyOut /
  // completed for officers who clocked in and back out.
  const closedByShift = new Map<string, { clockOutTime: Date; userId: string }>();
  {
    const entries = await db
      .select({
        userId: timeEntriesTable.employeeId,
        shiftId: timeEntriesTable.shiftId,
        clockOutTime: timeEntriesTable.clockOutTime,
      })
      .from(timeEntriesTable)
      .where(and(
        gte(timeEntriesTable.clockInTime, windowStart),
      ));
    for (const e of entries) {
      if (!e.shiftId || e.clockOutTime == null) continue;
      // Keep the latest closed entry per (shift,user)
      const k = `${e.shiftId}:${e.userId}`;
      const prev = closedByShift.get(k);
      if (!prev || e.clockOutTime > prev.clockOutTime) {
        closedByShift.set(k, { clockOutTime: e.clockOutTime, userId: e.userId });
      }
    }
  }

  const buckets = {
    onDuty: openEntries.map((e) => ({
      // Synthetic but unique key for the UI (no assignment is guaranteed for
      // an ad-hoc / wrong-shift clock-in). The clock-out action uses
      // timeEntryId, so on-behalf clock-out still works from this row.
      assignmentId: e.timeEntryId,
      shiftId: e.shiftId,
      shiftTitle: e.shiftTitle ?? null,
      startTime: e.startTime ?? null,
      endTime: e.endTime ?? null,
      siteId: e.shiftSiteId ?? e.teSiteId ?? null,
      siteName: e.siteName ?? null,
      siteAddress: e.siteAddress ?? null,
      userId: e.userId,
      officerName: `${e.firstName} ${e.lastName}`,
      lastLat: e.lastLat,
      lastLng: e.lastLng,
      lastLocationAt: e.lastLocationAt,
      clockInTime: e.clockInTime,
      timeEntryId: e.timeEntryId,
    })) as unknown[],
    late: [] as unknown[],
    noShow: [] as unknown[],
    earlyOut: [] as unknown[],
    completed: [] as unknown[],
    scheduled: [] as unknown[],
  };

  for (const r of rows) {
    // Clocked into THIS shift (or clocked in with no shift attached) → already
    // represented in onDuty above.
    if (onDutyShiftKeys.has(`${r.userId}:${r.shiftId}`) || onDutyUsersNoShift.has(r.userId)) continue;
    const key = `${r.shiftId}:${r.userId}`;
    const closed = closedByShift.get(key);
    const minsSinceStart = (now.getTime() - r.startTime.getTime()) / MS_MIN;

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

    if (closed) {
      // Officer clocked in AND out. If they clocked out well before the
      // scheduled end it's an early-out; otherwise the shift was worked
      // to (or near) completion. Either way they clearly showed up, so
      // this must NEVER fall through to the late / no-show branches.
      // Compare the actual clock-out against the scheduled end (NOT `now`),
      // so the classification is stable regardless of when the board is
      // queried — otherwise a genuine early-out flips to "completed" once
      // the current time passes the shift's end.
      const minsEarly = (r.endTime.getTime() - closed.clockOutTime.getTime()) / MS_MIN;
      if (minsEarly > EARLY_OUT_MIN) {
        buckets.earlyOut.push({
          ...base,
          clockOutTime: closed.clockOutTime,
          minutesEarly: Math.round(minsEarly),
        });
      } else {
        buckets.completed.push({ ...base, clockOutTime: closed.clockOutTime });
      }
      continue;
    }
    // No clock-in on record for this shift.
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
      claimableFrom: shiftsTable.claimableFrom,
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
router.post("/dispatch/assign-nearest", ...requireDispatchManage, async (req, res): Promise<void> => {
  const { shiftId, dryRun, overrideLicense } = (req.body ?? {}) as {
    shiftId?: string; dryRun?: boolean; overrideLicense?: boolean;
  };
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
        WHERE ${licensesTable.employeeId} = "users"."id"
          AND ${licensesTable.expiryDate} >= current_date
      )`,
      // Effective capability level: greater of highest unexpired licence level
      // and the universal worker baseline of 1 — level-1 support shifts need
      // no licence, so every worker surfaces for them.
      effLevel: sql<number>`GREATEST(
        COALESCE((
          SELECT MAX(${licensesTable.level})::int
          FROM ${licensesTable}
          WHERE ${licensesTable.employeeId} = "users"."id"
            AND ${licensesTable.expiryDate} >= current_date
        ), 0),
        1
      )`,
      alreadyAssigned: sql<boolean>`EXISTS (
        SELECT 1 FROM ${shiftAssignmentsTable}
        WHERE ${shiftAssignmentsTable.shiftId} = ${shiftId}
          AND ${shiftAssignmentsTable.employeeId} = "users"."id"
          AND ${shiftAssignmentsTable.status} IN ('accepted','pending')
      )`,
      conflictingShift: sql<boolean>`EXISTS (
        SELECT 1
          FROM ${shiftAssignmentsTable} sa2
          JOIN ${shiftsTable} s2 ON s2.id = sa2.shift_id
         WHERE sa2.employee_id = "users"."id"
           AND sa2.status = 'accepted'
           AND s2.id <> ${shiftId}
           AND s2.start_time < ${shift.endTime}
           AND s2.end_time   > ${shift.startTime}
      )`,
    })
    .from(usersTable)
    .where(and(
      inArray(usersTable.role, ["employee", "site_manager", "dispatcher", "admin"]),
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

  // Site work history: count completed time entries per officer at this site.
  // Officers who have worked here before sort first in the candidate roster.
  const siteWorkCounts = new Map<string, number>();
  if (shift.siteId && qualifiedIds.length > 0) {
    const siteCounts = await db
      .select({
        employeeId: timeEntriesTable.employeeId,
        cnt: sql<number>`COUNT(*)::int`,
      })
      .from(timeEntriesTable)
      .where(and(
        eq(timeEntriesTable.siteId, shift.siteId),
        isNotNull(timeEntriesTable.clockOutTime),
        inArray(timeEntriesTable.employeeId, qualifiedIds),
      ))
      .groupBy(timeEntriesTable.employeeId);
    for (const row of siteCounts) {
      siteWorkCounts.set(row.employeeId, row.cnt);
    }
  }

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
    effectiveLevel: number;
    meetsLicense: boolean;
    alreadyAssigned: boolean;
    conflictingShift: boolean;
    availabilityKnown: boolean;
    availabilityCovers: boolean;
    workedSiteBefore: boolean;
    siteShiftCount: number;
  };
  // Normally only officers whose effective level meets the requirement are
  // ranked. With overrideLicense (admin/dispatcher judgement call) we include
  // under-licensed officers too, flagged via `meetsLicense:false`, and sink
  // them below qualified candidates so the auto-pick still prefers a qualified
  // officer when one is available.
  const candidates: Candidate[] = qualified
    .filter((q) => overrideLicense === true || (q.effLevel ?? 0) >= shift.requiredLicenseLevel)
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
        effectiveLevel: q.effLevel ?? 0,
        meetsLicense: (q.effLevel ?? 0) >= shift.requiredLicenseLevel,
        alreadyAssigned: q.alreadyAssigned,
        conflictingShift: q.conflictingShift,
        availabilityKnown: a?.hasAny ?? false,
        availabilityCovers: a?.covers ?? false,
        siteShiftCount: siteWorkCounts.get(q.userId) ?? 0,
        workedSiteBefore: (siteWorkCounts.get(q.userId) ?? 0) > 0,
      };
    })
    .sort((a, b) => {
      // Hard-deprioritize already-assigned / conflicting / unavailable /
      // under-licensed candidates: they remain visible in the response (so the
      // UI can explain why someone is flagged) but are pushed to the bottom
      // and excluded from the auto-pick.
      const aBad = a.alreadyAssigned || a.conflictingShift || (a.availabilityKnown && !a.availabilityCovers) || !a.meetsLicense;
      const bBad = b.alreadyAssigned || b.conflictingShift || (b.availabilityKnown && !b.availabilityCovers) || !b.meetsLicense;
      if (aBad !== bBad) return aBad ? 1 : -1;
      // Within each eligibility group, site veterans sort first.
      const aVet = a.workedSiteBefore ? 0 : 1;
      const bVet = b.workedSiteBefore ? 0 : 1;
      if (aVet !== bVet) return aVet - bVet;
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
      // Return the full ranked roster (already computed above) so the admin
      // can search for ANY officer in the assign dialog, not just the nearest
      // few. The auto-pick still uses the top eligible candidate.
      candidates,
      topCandidate: top,
    });
    return;
  }

  // Atomic assign with headcount re-check.
  const result = await db.transaction(async (tx) => {
    // Serialize concurrent assignments against the same shift: take a
    // row-level lock on the shift before re-checking filled count. The
    // second tx blocks here, then sees the updated count and 409s,
    // instead of racing past the count check and hitting a duplicate
    // insert.
    await tx.execute(
      sql`SELECT id FROM ${shiftsTable} WHERE id = ${shiftId} FOR UPDATE`,
    );
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
      // Contact info for the SOS map popup. Staff-only surface (this route
      // is requireAdminOrDispatcher); account phone wins, HR-file phone is
      // the fallback. NEVER copy these fields onto any client-portal read.
      employeePhone: sql<string | null>`COALESCE(${usersTable.phoneNumber}, ${employeesTable.phone})`,
      employeeEmail: usersTable.email,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(incidentsTable.employeeId, usersTable.id))
    .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
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

/** Round worked hours to 0.01h, matching the self clock-out path. */
function calcHoursWorked(clockIn: Date, clockOut: Date): number {
  return Math.round(((clockOut.getTime() - clockIn.getTime()) / 3_600_000) * 100) / 100;
}

/**
 * POST /dispatch/officers/:userId/clock-in { shiftId?, siteId?, notes? }
 *
 * Admin-only on-behalf clock-in from the Dispatch status board (e.g. an
 * officer whose phone died, or a manual correction). Unlike the officer
 * self clock-in this carries NO GPS coords (the dispatcher isn't on site),
 * so clockInLat/Lng stay null and there is no geofence/radius resolution.
 * Site is resolved from the shift (preferred), else an explicit siteId.
 * The action is audit-logged under the `/dispatch` prefix.
 */
router.post("/dispatch/officers/:userId/clock-in", requireAdmin, async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const { shiftId, siteId, notes } = (req.body ?? {}) as {
    shiftId?: string; siteId?: string; notes?: string;
  };

  const [officer] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!officer || officer.role !== "employee") {
    res.status(404).json({ error: "Not Found", message: "Officer not found" });
    return;
  }

  // Resolve the site (read-only, safe outside the tx): prefer the shift's
  // site, fall back to an explicit siteId. A clock-in with no site at all is
  // allowed (ad-hoc) but rare.
  let resolvedSiteId: string | null = null;
  if (shiftId) {
    const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId)).limit(1);
    if (!shift) { res.status(404).json({ error: "Not Found", message: "Shift not found" }); return; }
    if (shift.status === "completed" || shift.status === "cancelled") {
      res.status(409).json({ error: "Conflict", message: `This shift is ${shift.status} — you can't clock in to it.` });
      return;
    }
    resolvedSiteId = shift.siteId ?? null;
  } else if (siteId) {
    const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, siteId)).limit(1);
    if (!site) { res.status(404).json({ error: "Not Found", message: "Site not found" }); return; }
    resolvedSiteId = site.id;
  }

  const dispatchNote = `Clocked in by dispatch (admin ${req.user?.userId ?? "admin"})`;

  // Atomic open-entry guard + insert. There is no DB-level uniqueness on
  // "one open entry per officer", so concurrent dispatch clicks could each
  // pass a bare check-then-insert and double-clock the officer. We serialize
  // per-officer by taking a row lock on the officer's users row (FOR UPDATE)
  // inside the tx; any racing request blocks here until the first commits,
  // then sees the open entry and bails with a 409.
  let outcome: { conflict: true } | { entry: typeof timeEntriesTable.$inferSelect };
  try {
    outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${usersTable} WHERE ${usersTable.id} = ${userId} FOR UPDATE`);

      const open = await tx
        .select({ id: timeEntriesTable.id })
        .from(timeEntriesTable)
        .where(and(eq(timeEntriesTable.employeeId, userId), isNull(timeEntriesTable.clockOutTime)))
        .limit(1);
      if (open.length > 0) return { conflict: true as const };

      const [entry] = await tx.insert(timeEntriesTable).values({
        shiftId: shiftId || null,
        siteId: resolvedSiteId,
        employeeId: userId,
        clockInTime: new Date(),
        clockInLat: null,
        clockInLng: null,
        notes: notes ? `${dispatchNote} — ${notes}` : dispatchNote,
        isVerified: false,
        approvalStatus: "pending",
      }).returning();

      // Flip the linked shift active so My Shifts / dashboards reflect on-duty.
      if (shiftId) {
        await tx
          .update(shiftsTable)
          .set({ status: "active" })
          .where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.status, "upcoming")));
      }

      return { entry };
    });
  } catch (err) {
    // The partial unique index on time_entries (one open entry per employee)
    // is the last line of defence behind the row lock above. Surface it as the
    // route's normal 409, not a 500.
    if (!isOpenTimeEntryConflict(err)) throw err;
    req.log.warn({ officerId: userId }, "[dispatch] blocked duplicate open time entry at the database");
    outcome = { conflict: true };
  }

  if ("conflict" in outcome) {
    res.status(409).json({ error: "Conflict", message: "Officer is already clocked in." });
    return;
  }

  // Real-time push: surface the just-clocked-in officer on the live map
  // immediately instead of waiting for the next 30s active-officers poll.
  broadcastOfficerJoined(userId);

  req.log.info({ officerId: userId, shiftId, siteId: resolvedSiteId, actor: req.user?.userId }, "dispatch on-behalf clock-in");
  res.status(201).json({
    ...outcome.entry,
    officerName: `${officer.firstName} ${officer.lastName}`,
  });
});

/**
 * POST /dispatch/officers/:userId/clock-out { timeEntryId?, notes? }
 *
 * Admin-only on-behalf clock-out from the Dispatch status board. Closes the
 * officer's open entry (by explicit timeEntryId, else the single open entry),
 * stamps clockOutTime=now, computes hoursWorked, and completes the linked
 * shift when no other officer is still clocked in. No GPS coords (dispatcher
 * isn't on site). Audit-logged under the `/dispatch` prefix.
 */
router.post("/dispatch/officers/:userId/clock-out", requireAdmin, async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const { timeEntryId, notes } = (req.body ?? {}) as { timeEntryId?: string; notes?: string };

  const [entry] = timeEntryId
    ? await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, timeEntryId)).limit(1)
    : await db
        .select()
        .from(timeEntriesTable)
        .where(and(eq(timeEntriesTable.employeeId, userId), isNull(timeEntriesTable.clockOutTime)))
        // Deterministic pick: if bad data ever left >1 open entry, close the
        // most recently opened one rather than an arbitrary row.
        .orderBy(desc(timeEntriesTable.clockInTime))
        .limit(1);

  if (!entry) {
    res.status(404).json({ error: "Not Found", message: "No open time entry for this officer." });
    return;
  }
  if (entry.employeeId !== userId) {
    res.status(400).json({ error: "Bad Request", message: "That time entry does not belong to this officer." });
    return;
  }
  if (entry.clockOutTime) {
    res.status(409).json({ error: "Conflict", message: "Officer is already clocked out." });
    return;
  }

  const clockOut = new Date();
  const dispatchNote = `Clocked out by dispatch (admin ${req.user?.userId ?? "admin"})`;
  const [updated] = await db.update(timeEntriesTable).set({
    clockOutTime: clockOut,
    clockOutLat: null,
    clockOutLng: null,
    hoursWorked: String(calcHoursWorked(entry.clockInTime, clockOut)),
    notes: notes
      ? `${entry.notes ? `${entry.notes} — ` : ""}${dispatchNote} — ${notes}`
      : `${entry.notes ? `${entry.notes} — ` : ""}${dispatchNote}`,
  }).where(eq(timeEntriesTable.id, entry.id)).returning();

  // Complete the shift only when no other officer still has an open entry,
  // mirroring the self clock-out's TOCTOU-safe NOT EXISTS predicate.
  if (updated.shiftId) {
    await db
      .update(shiftsTable)
      .set({ status: "completed" })
      .where(and(
        eq(shiftsTable.id, updated.shiftId),
        eq(shiftsTable.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${timeEntriesTable}
          WHERE ${timeEntriesTable.shiftId} = ${updated.shiftId}
            AND ${timeEntriesTable.clockOutTime} IS NULL
        )`,
      ));
  }

  req.log.info({ officerId: userId, timeEntryId: updated.id, actor: req.user?.userId }, "dispatch on-behalf clock-out");
  const [officer] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  res.json({
    ...updated,
    officerName: officer ? `${officer.firstName} ${officer.lastName}` : null,
  });
});

export default router;
