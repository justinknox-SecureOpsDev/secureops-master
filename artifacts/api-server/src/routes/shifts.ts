import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { db, shiftsTable, shiftAssignmentsTable, usersTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/shifts", requireAuth, async (req, res): Promise<void> => {
  const { status, employeeId, from, to } = req.query as { status?: string; employeeId?: string; from?: string; to?: string };

  const conditions = [];
  if (status) conditions.push(eq(shiftsTable.status, status));
  if (from) conditions.push(gte(shiftsTable.startTime, new Date(from)));
  if (to) conditions.push(lte(shiftsTable.startTime, new Date(to)));

  let shifts;
  if (employeeId) {
    const assignedShiftIds = await db
      .select({ shiftId: shiftAssignmentsTable.shiftId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.employeeId, employeeId));
    const ids = assignedShiftIds.map((r) => r.shiftId);
    if (ids.length === 0) { res.json([]); return; }
    conditions.push(sql`${shiftsTable.id} = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`)}) `);
    shifts = await db.select().from(shiftsTable).where(conditions.length > 0 ? and(...conditions) : undefined);
  } else {
    shifts = conditions.length > 0
      ? await db.select().from(shiftsTable).where(and(...conditions))
      : await db.select().from(shiftsTable);
  }

  const shiftIds = shifts.map((s) => s.id);
  if (shiftIds.length === 0) { res.json(shifts.map((s) => ({ ...s, assignments: [] }))); return; }

  const assignments = await db
    .select({
      id: shiftAssignmentsTable.id,
      shiftId: shiftAssignmentsTable.shiftId,
      employeeId: shiftAssignmentsTable.employeeId,
      status: shiftAssignmentsTable.status,
      createdAt: shiftAssignmentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(shiftAssignmentsTable)
    .leftJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id));

  const assignmentMap = new Map<string, typeof assignments>();
  for (const a of assignments) {
    if (!assignmentMap.has(a.shiftId)) assignmentMap.set(a.shiftId, []);
    assignmentMap.get(a.shiftId)!.push(a);
  }

  res.json(shifts.map((s) => ({ ...s, assignments: assignmentMap.get(s.id) ?? [] })));
});

router.post("/shifts", requireAdmin, async (req, res): Promise<void> => {
  const { title, clientName, location, locationLat, locationLng, startTime, endTime, hourlyRate, billableRate, isRepeat, repeatPattern, notes, employeeIds } = req.body;
  if (!title || !clientName || !location || !startTime || !endTime || hourlyRate == null) {
    res.status(400).json({ error: "Bad Request", message: "Missing required fields" });
    return;
  }
  const [shift] = await db.insert(shiftsTable).values({
    title,
    clientName,
    location,
    locationLat: locationLat ? String(locationLat) : null,
    locationLng: locationLng ? String(locationLng) : null,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    hourlyRate: String(hourlyRate),
    billableRate: billableRate ? String(billableRate) : null,
    isRepeat: isRepeat || false,
    repeatPattern: repeatPattern || null,
    notes: notes || null,
    status: "upcoming",
  }).returning();

  if (employeeIds && Array.isArray(employeeIds) && employeeIds.length > 0) {
    await db.insert(shiftAssignmentsTable).values(
      employeeIds.map((eid: string) => ({ shiftId: shift.id, employeeId: eid, status: "pending" }))
    );
  }

  res.status(201).json({ ...shift, assignments: [] });
});

router.get("/shifts/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, id));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  const assignments = await db
    .select({
      id: shiftAssignmentsTable.id,
      shiftId: shiftAssignmentsTable.shiftId,
      employeeId: shiftAssignmentsTable.employeeId,
      status: shiftAssignmentsTable.status,
      createdAt: shiftAssignmentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(shiftAssignmentsTable)
    .leftJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id))
    .where(eq(shiftAssignmentsTable.shiftId, id));

  res.json({ ...shift, assignments });
});

router.put("/shifts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { title, clientName, location, locationLat, locationLng, startTime, endTime, hourlyRate, billableRate, status, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (title) updates.title = title;
  if (clientName) updates.clientName = clientName;
  if (location) updates.location = location;
  if (locationLat !== undefined) updates.locationLat = String(locationLat);
  if (locationLng !== undefined) updates.locationLng = String(locationLng);
  if (startTime) updates.startTime = new Date(startTime);
  if (endTime) updates.endTime = new Date(endTime);
  if (hourlyRate !== undefined) updates.hourlyRate = String(hourlyRate);
  if (billableRate !== undefined) updates.billableRate = String(billableRate);
  if (status) updates.status = status;
  if (notes !== undefined) updates.notes = notes;

  const [shift] = await db.update(shiftsTable).set(updates).where(eq(shiftsTable.id, id)).returning();
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }
  res.json({ ...shift, assignments: [] });
});

router.delete("/shifts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(shiftsTable).where(eq(shiftsTable.id, id));
  res.sendStatus(204);
});

router.post("/shifts/:id/assignments", requireAdmin, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { employeeId } = req.body;
  if (!employeeId) { res.status(400).json({ error: "Bad Request", message: "employeeId required" }); return; }
  const [assignment] = await db.insert(shiftAssignmentsTable).values({ shiftId, employeeId, status: "pending" }).returning();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));
  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));

  // Send push notification to the assigned employee
  if (shift) {
    const { sendPushToUsers } = await import("../lib/push");
    const start = new Date(shift.startTime).toLocaleString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    await sendPushToUsers([employeeId], {
      title: "📋 New Shift Assigned",
      body: `You've been assigned to ${shift.title} on ${start}`,
      data: { type: "shift_assigned", shiftId },
    });
  }

  res.status(201).json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.put("/shifts/:id/assignments/:assignmentId", requireAuth, async (req, res): Promise<void> => {
  const assignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const { status } = req.body;
  if (!status) { res.status(400).json({ error: "Bad Request", message: "status required" }); return; }
  const [assignment] = await db.update(shiftAssignmentsTable).set({ status }).where(eq(shiftAssignmentsTable.id, assignmentId)).returning();
  if (!assignment) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, assignment.employeeId));
  res.json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

export default router;
