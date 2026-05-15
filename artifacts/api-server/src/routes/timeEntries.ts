import { Router, type IRouter } from "express";
import { eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { db, timeEntriesTable, shiftsTable, usersTable, sitesTable } from "@workspace/db";
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
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
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

  // Geo-resolve site if no shiftId provided.
  let resolvedSite: { id: string; name: string; distanceMiles: number } | null = null;
  if (!shiftId) {
    resolvedSite = await resolveNearestSite(Number(lat), Number(lng));
    if (!resolvedSite) {
      res.status(422).json({
        error: "No Site Nearby",
        message: `You are not within ${GEO_RESOLVE_RADIUS_MILES} mile of any known site. Move closer to a site or have an admin assign you to a shift first.`,
      });
      return;
    }
  }

  const [entry] = await db.insert(timeEntriesTable).values({
    shiftId: shiftId || null,
    siteId: resolvedSite ? resolvedSite.id : null,
    employeeId: req.user!.userId,
    clockInTime: new Date(),
    clockInLat: String(lat),
    clockInLng: String(lng),
    notes: notes || null,
    isVerified: false,
    approvalStatus: "pending",
  }).returning();

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
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(and(eq(timeEntriesTable.employeeId, req.user!.userId), isNull(timeEntriesTable.clockOutTime)));

  if (!entry) { res.status(404).json({ error: "Not Found", message: "No active time entry" }); return; }
  res.json(entry);
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
