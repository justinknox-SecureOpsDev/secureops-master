import { Router, type IRouter } from "express";
import { eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import { db, timeEntriesTable, shiftsTable, usersTable, sitesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

function calcHours(clockIn: Date, clockOut: Date): number {
  return Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100;
}

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
  siteId: shiftsTable.siteId,
  siteName: sitesTable.name,
  payRate: shiftsTable.payRate,
  billRate: shiftsTable.billRate,
  employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
};

router.get("/time-entries", requireAuth, async (req, res): Promise<void> => {
  const { employeeId, shiftId, siteId, approvalStatus, from, to } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (req.user!.role !== "admin") {
    conditions.push(eq(timeEntriesTable.employeeId, req.user!.userId));
  } else if (employeeId) {
    conditions.push(eq(timeEntriesTable.employeeId, employeeId));
  }
  if (shiftId) conditions.push(eq(timeEntriesTable.shiftId, shiftId));
  if (siteId) conditions.push(eq(shiftsTable.siteId, siteId));
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
  if (!shiftId || lat == null || lng == null) {
    res.status(400).json({ error: "Bad Request", message: "shiftId, lat, lng required" });
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

  const [entry] = await db.insert(timeEntriesTable).values({
    shiftId,
    employeeId: req.user!.userId,
    clockInTime: new Date(),
    clockInLat: String(lat),
    clockInLng: String(lng),
    notes: notes || null,
    isVerified: false,
    approvalStatus: "pending",
  }).returning();

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));

  res.status(201).json({
    ...entry,
    shiftTitle: shift?.title,
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

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId));
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
  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId));
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));
  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

export default router;
