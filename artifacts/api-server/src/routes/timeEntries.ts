import { Router, type IRouter } from "express";
import { eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { db, timeEntriesTable, shiftsTable, usersTable, sitesTable, shiftAssignmentsTable, licensesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

function calcHours(clockIn: Date, clockOut: Date): number {
  return Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100;
}

// Coalesce: prefer the time entry's direct siteId (set by geo-resolution when no shift),
// otherwise fall back to the linked shift's siteId.
const baseSelect = {
  id: timeEntriesTable.id,
  shiftId: timeEntriesTable.shiftId,
  employeeId: timeEntriesTable.employeeId,
  clockInTime: timeEntriesTable.clockInTime,
  clockInLat: timeEntriesTable.clockInLat,
  clockInLng: timeEntriesTable.clockInLng,
  clockOutTime: timeEntriesTable.clockOutTime,
  clockOutLat: timeEntriesTable.clockOutLat,
  clockOutLng: timeEntriesTable.clockOutLng,
  hoursWorked: timeEntriesTable.hoursWorked,
  isVerified: timeEntriesTable.isVerified,
  approvalStatus: timeEntriesTable.approvalStatus,
  approvedAt: timeEntriesTable.approvedAt,
  approvedBy: timeEntriesTable.approvedBy,
  notes: timeEntriesTable.notes,
  createdAt: timeEntriesTable.createdAt,
  shiftTitle: shiftsTable.title,
  siteId: sql<string | null>`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`,
  siteName: sitesTable.name,
  payRate: shiftsTable.payRate,
  billRate: shiftsTable.billRate,
  employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
};

// Haversine distance in miles between two lat/lng points.
function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const GEO_RESOLVE_RADIUS_MILES = 1;

// Find the closest Site within GEO_RESOLVE_RADIUS_MILES of (lat, lng), or null.
async function resolveNearestSite(lat: number, lng: number): Promise<{ id: string; name: string; distanceMiles: number } | null> {
  const sites = await db
    .select({ id: sitesTable.id, name: sitesTable.name, lat: sitesTable.locationLat, lng: sitesTable.locationLng })
    .from(sitesTable)
    .where(and(
      sql`${sitesTable.locationLat} IS NOT NULL`,
      sql`${sitesTable.locationLng} IS NOT NULL`,
    ));
  let best: { id: string; name: string; distanceMiles: number } | null = null;
  for (const s of sites) {
    if (s.lat == null || s.lng == null) continue;
    const d = haversineMiles(lat, lng, Number(s.lat), Number(s.lng));
    if (d <= GEO_RESOLVE_RADIUS_MILES && (!best || d < best.distanceMiles)) {
      best = { id: s.id, name: s.name, distanceMiles: d };
    }
  }
  return best;
}

router.get("/time-entries", requireAuth, async (req, res): Promise<void> => {
  const { employeeId, shiftId, siteId, approvalStatus, from, to } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (req.user!.role !== "admin") {
    conditions.push(eq(timeEntriesTable.employeeId, req.user!.userId));
  } else if (employeeId) {
    conditions.push(eq(timeEntriesTable.employeeId, employeeId));
  }
  if (shiftId) conditions.push(eq(timeEntriesTable.shiftId, shiftId));
  if (siteId) conditions.push(sql`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId}) = ${siteId}`);
  if (approvalStatus) conditions.push(eq(timeEntriesTable.approvalStatus, approvalStatus));
  if (from) conditions.push(gte(timeEntriesTable.clockInTime, new Date(from)));
  if (to) conditions.push(lte(timeEntriesTable.clockInTime, new Date(to)));

  const rows = await db
    .select(baseSelect)
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`)
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows);
});

router.post("/time-entries/clock-in", requireAuth, async (req, res): Promise<void> => {
  const { shiftId, lat, lng, notes } = req.body;
  if (lat == null || lng == null) {
    res.status(400).json({ error: "Bad Request", message: "lat, lng required" });
    return;
  }
  const existing = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, req.user!.userId), isNull(timeEntriesTable.clockOutTime)));

  if (existing.length > 0) {
    res.status(400).json({ error: "Bad Request", message: "Already clocked in" });
    return;
  }

  // License compliance: officers must hold at least one unexpired security
  // license to clock in. Admins are exempt (they may be helping cover a
  // shift or troubleshooting a stuck record on someone else's behalf).
  // 403 with a precise message so the mobile UI can surface the exact
  // reason — see the banner on the employee Home tab.
  if (req.user!.role !== "admin") {
    const [{ count: validLicenses }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(licensesTable)
      .where(and(
        eq(licensesTable.employeeId, req.user!.userId),
        gte(licensesTable.expiryDate, sql`current_date`),
      ));
    if (!validLicenses) {
      res.status(403).json({
        error: "Forbidden",
        code: "license_expired",
        message: "Your security license has expired or is missing. Upload a renewed license from Profile → My licenses before clocking in.",
      });
      return;
    }
  }

  // Geo-resolve site if no shiftId provided.
  let resolvedSite: { id: string; name: string; distanceMiles: number } | null = null;
  let assignedShiftSiteId: string | null = null;
  if (shiftId) {
    // Validate the shift exists and the user is assigned to it (admins may
    // clock in on behalf of any user, but normal employees can only clock in
    // to shifts they have an accepted assignment for). When shiftId is
    // provided we skip the geo-radius check entirely and just trust the
    // assignment — this is the "click on my shift to clock in" flow.
    const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
    if (!shift) {
      res.status(404).json({ error: "Not Found", message: "Shift not found" });
      return;
    }
    if (shift.status === "completed" || shift.status === "cancelled") {
      res.status(409).json({
        error: "Conflict",
        message: `This shift is ${shift.status} — you can't clock in to it.`,
      });
      return;
    }
    if (req.user!.role !== "admin") {
      const assignment = await db
        .select()
        .from(shiftAssignmentsTable)
        .where(and(
          eq(shiftAssignmentsTable.shiftId, shiftId),
          eq(shiftAssignmentsTable.employeeId, req.user!.userId),
          eq(shiftAssignmentsTable.status, "accepted"),
        ));
      if (assignment.length === 0) {
        res.status(403).json({
          error: "Forbidden",
          message: "You are not assigned to this shift. Reserve it first from the Shifts tab.",
        });
        return;
      }
    }
    assignedShiftSiteId = shift.siteId ?? null;
  } else {
    resolvedSite = await resolveNearestSite(Number(lat), Number(lng));
    if (!resolvedSite) {
      res.status(422).json({
        error: "No Site Nearby",
        message: `You are not within ${GEO_RESOLVE_RADIUS_MILES} mile of any known site. Move closer to a site or tap a reserved shift in the Shifts tab to clock in to it directly.`,
      });
      return;
    }
  }

  const [entry] = await db.insert(timeEntriesTable).values({
    shiftId: shiftId || null,
    siteId: resolvedSite ? resolvedSite.id : assignedShiftSiteId,
    employeeId: req.user!.userId,
    clockInTime: new Date(),
    clockInLat: String(lat),
    clockInLng: String(lng),
    notes: notes || null,
    isVerified: false,
    approvalStatus: "pending",
  }).returning();

  // When clocking into a specific shift, flip its status to "active" so the
  // mobile app's My Shifts → Active tab (and admin dashboards) reflect the
  // on-duty state. Don't downgrade if it's already past upcoming.
  if (shiftId) {
    await db
      .update(shiftsTable)
      .set({ status: "active" })
      .where(and(eq(shiftsTable.id, shiftId), eq(shiftsTable.status, "upcoming")));
  }

  const [shift] = shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));

  res.status(201).json({
    ...entry,
    shiftTitle: shift?.title ?? null,
    siteId: entry.siteId ?? shift?.siteId ?? null,
    siteName: resolvedSite?.name ?? null,
    geoResolved: resolvedSite ? { siteName: resolvedSite.name, distanceMiles: Math.round(resolvedSite.distanceMiles * 100) / 100 } : null,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

router.post("/time-entries/clock-out", requireAuth, async (req, res): Promise<void> => {
  const { timeEntryId, lat, lng, notes } = req.body;
  if (!timeEntryId || lat == null || lng == null) {
    res.status(400).json({ error: "Bad Request", message: "timeEntryId, lat, lng required" });
    return;
  }

  const [entry] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, timeEntryId));
  if (!entry) { res.status(404).json({ error: "Not Found" }); return; }
  if (entry.employeeId !== req.user!.userId && req.user!.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const clockOut = new Date();
  const hours = calcHours(entry.clockInTime, clockOut);

  const [updated] = await db.update(timeEntriesTable).set({
    clockOutTime: clockOut,
    clockOutLat: String(lat),
    clockOutLng: String(lng),
    hoursWorked: String(hours),
    notes: notes || entry.notes,
  }).where(eq(timeEntriesTable.id, timeEntryId)).returning();

  // If this entry was tied to a shift, mark the shift completed — but ONLY
  // when no other officer still has an open time entry on it. The NOT EXISTS
  // predicate runs inside the same UPDATE so we close the TOCTOU window
  // between "check open entries" and "set completed": if another officer
  // races a clock-in for the same shift between this clock-out's row update
  // and the shift update, the WHERE will see their open entry and skip the
  // status flip — leaving the shift correctly in "active".
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

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

router.get("/time-entries/active", requireAuth, async (req, res): Promise<void> => {
  const [entry] = await db
    .select(baseSelect)
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`)
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(and(eq(timeEntriesTable.employeeId, req.user!.userId), isNull(timeEntriesTable.clockOutTime)));

  // Return 200 with null rather than 404 when there's no active entry — this
  // lets react-query (and our mobile clock screen) cleanly clear stale data
  // after a clock-out instead of treating "no entry" as an error and keeping
  // the previous cached value.
  if (!entry) { res.json(null); return; }
  res.json(entry);
});

// Admin patches a missing clock-out on an existing time entry.
//
// Used from the Payroll Board "Missing clock-out" warning so admins can
// fix a stuck entry in one click instead of editing the raw DB row.
// Accepts either an explicit ISO clockOutTime, or `useShiftEnd:true` to
// snap to the linked shift's scheduled end. Recomputes hoursWorked from
// the new clock-out and clockIn (rounded to 0.01h, matching clock-out).
// Rejects entries that already have a clockOutTime to avoid silently
// overwriting verified payroll data.
router.patch("/time-entries/:id/clock-out", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { clockOutTime, useShiftEnd, notes } = req.body ?? {};

  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (existing.clockOutTime) {
    res.status(409).json({
      error: "Conflict",
      message: "This time entry already has a clock-out time. Edit it from the time entries grid instead.",
    });
    return;
  }

  let targetClockOut: Date | null = null;
  if (useShiftEnd) {
    if (!existing.shiftId) {
      res.status(400).json({
        error: "Bad Request",
        message: "This entry isn't linked to a shift, so there is no scheduled end. Provide an explicit clockOutTime instead.",
      });
      return;
    }
    const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, existing.shiftId));
    if (!shift) {
      res.status(400).json({ error: "Bad Request", message: "Linked shift no longer exists." });
      return;
    }
    targetClockOut = shift.endTime;
  } else if (clockOutTime) {
    const parsed = new Date(clockOutTime);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockOutTime must be a valid ISO timestamp." });
      return;
    }
    targetClockOut = parsed;
  } else {
    res.status(400).json({ error: "Bad Request", message: "Provide clockOutTime or useShiftEnd:true." });
    return;
  }

  if (targetClockOut.getTime() <= existing.clockInTime.getTime()) {
    res.status(400).json({
      error: "Bad Request",
      message: "Clock-out must be after clock-in.",
    });
    return;
  }

  const hours = calcHours(existing.clockInTime, targetClockOut);

  const [updated] = await db.update(timeEntriesTable).set({
    clockOutTime: targetClockOut,
    hoursWorked: String(hours),
    notes: notes ?? existing.notes,
  }).where(eq(timeEntriesTable.id, id)).returning();

  // Mirror the clock-out endpoint's shift-completion flip so an open shift
  // doesn't stay "active" after the admin patches the only outstanding entry.
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

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

// Admin approves/rejects a time entry. Approval is required before payroll/invoice picks it up.
router.post("/time-entries/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { decision, hoursWorked, notes } = req.body;
  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: "Bad Request", message: "decision must be 'approved' or 'rejected'" });
    return;
  }
  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (!existing.clockOutTime) {
    res.status(400).json({ error: "Bad Request", message: "Cannot approve a time entry that hasn't been clocked out" });
    return;
  }

  const updates: Record<string, unknown> = {
    approvalStatus: decision,
    approvedAt: new Date(),
    approvedBy: req.user!.userId,
    isVerified: decision === "approved",
  };
  if (hoursWorked !== undefined) updates.hoursWorked = String(hoursWorked);
  if (notes !== undefined) updates.notes = notes;

  const [updated] = await db.update(timeEntriesTable).set(updates).where(eq(timeEntriesTable.id, id)).returning();
  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));
  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

export default router;
