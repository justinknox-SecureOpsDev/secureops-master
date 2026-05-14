import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, or, isNull } from "drizzle-orm";
import { db, shiftsTable, shiftAssignmentsTable, usersTable, licensesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

async function getEmployeeMaxLevel(employeeId: string): Promise<number | null> {
  const rows = await db
    .select({ level: licensesTable.level })
    .from(licensesTable)
    .where(and(
      eq(licensesTable.employeeId, employeeId),
      gte(licensesTable.expiryDate, sql`current_date`),
    ));
  let max: number | null = null;
  for (const r of rows) {
    if (r.level != null && (max == null || r.level > max)) max = r.level;
  }
  return max;
}

router.get("/shifts", requireAuth, async (req, res): Promise<void> => {
  const { status, employeeId, from, to } = req.query as { status?: string; employeeId?: string; from?: string; to?: string };
  const isAdmin = req.user!.role === "admin";
  const userId = req.user!.userId;

  const conditions = [];
  if (status) conditions.push(eq(shiftsTable.status, status));
  if (from) conditions.push(gte(shiftsTable.startTime, new Date(from)));
  if (to) conditions.push(lte(shiftsTable.startTime, new Date(to)));

  // Non-admins are limited: only shifts they're assigned to OR open shifts they qualify for.
  let restrictToEmployee: string | undefined;
  if (!isAdmin) {
    restrictToEmployee = userId;
  } else if (employeeId) {
    restrictToEmployee = employeeId;
  }

  let shifts;
  if (restrictToEmployee) {
    const myMaxLevel = !isAdmin ? (await getEmployeeMaxLevel(userId)) ?? 0 : 4;
    const assignedRows = await db
      .select({ shiftId: shiftAssignmentsTable.shiftId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.employeeId, restrictToEmployee));
    const assignedIds = assignedRows.map((r) => r.shiftId);

    const all = conditions.length > 0
      ? await db.select().from(shiftsTable).where(and(...conditions))
      : await db.select().from(shiftsTable);

    if (isAdmin) {
      shifts = all.filter((s) => assignedIds.includes(s.id));
    } else {
      // Employee sees: assigned shifts + open shifts they qualify for (upcoming, not full)
      const counts = await db
        .select({ shiftId: shiftAssignmentsTable.shiftId, n: sql<number>`count(*)::int` })
        .from(shiftAssignmentsTable)
        .groupBy(shiftAssignmentsTable.shiftId);
      const countMap = new Map(counts.map((c) => [c.shiftId, c.n]));
      shifts = all.filter((s) => {
        if (assignedIds.includes(s.id)) return true;
        if (s.status !== "upcoming") return false;
        if (myMaxLevel < s.requiredLicenseLevel) return false;
        if ((countMap.get(s.id) ?? 0) >= s.headcount) return false;
        return true;
      });
    }
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
  const { title, clientName, location, locationLat, locationLng, startTime, endTime, hourlyRate, billableRate, isRepeat, repeatPattern, notes, employeeIds, requiredLicenseLevel, headcount } = req.body;
  if (!title || !clientName || !location || !startTime || !endTime || hourlyRate == null) {
    res.status(400).json({ error: "Bad Request", message: "Missing required fields" });
    return;
  }
  const lvl = [2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
  const hc = Math.max(1, Number(headcount) || 1);

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
    requiredLicenseLevel: lvl,
    headcount: hc,
  }).returning();

  if (employeeIds && Array.isArray(employeeIds) && employeeIds.length > 0) {
    await db.insert(shiftAssignmentsTable).values(
      employeeIds.map((eid: string) => ({ shiftId: shift.id, employeeId: eid, status: "pending" }))
    );
  }

  // Broadcast push notification to all qualifying active employees
  try {
    const candidates = await db
      .select({
        userId: usersTable.id,
        maxLevel: sql<number | null>`max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date)`,
      })
      .from(usersTable)
      .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
      .where(and(eq(usersTable.role, "employee"), eq(usersTable.status, "active")))
      .groupBy(usersTable.id);

    const eligibleIds = candidates
      .filter((c) => (c.maxLevel ?? 0) >= lvl)
      .map((c) => c.userId);

    if (eligibleIds.length > 0) {
      const { sendPushToUsers } = await import("../lib/push");
      const start = new Date(shift.startTime).toLocaleString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const levelLabel = lvl === 4 ? "L4/PPO" : `L${lvl}+`;
      await sendPushToUsers(eligibleIds, {
        title: `🛡️ New ${levelLabel} Shift Available`,
        body: `${shift.title} @ ${shift.clientName} — ${start}`,
        data: { type: "shift_available", shiftId: shift.id },
      });
    }
  } catch (err) {
    req.log.warn({ err }, "Failed to broadcast new shift push");
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
  const { title, clientName, location, locationLat, locationLng, startTime, endTime, hourlyRate, billableRate, status, notes, requiredLicenseLevel, headcount } = req.body;
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
  if (requiredLicenseLevel !== undefined && [2, 3, 4].includes(Number(requiredLicenseLevel))) {
    updates.requiredLicenseLevel = Number(requiredLicenseLevel);
  }
  if (headcount !== undefined) updates.headcount = Math.max(1, Number(headcount) || 1);

  const [shift] = await db.update(shiftsTable).set(updates).where(eq(shiftsTable.id, id)).returning();
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }
  res.json({ ...shift, assignments: [] });
});

router.delete("/shifts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(shiftsTable).where(eq(shiftsTable.id, id));
  res.sendStatus(204);
});

router.post("/shifts/:id/claim", requireAuth, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userId = req.user!.userId;

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found", message: "Shift not found" }); return; }
  if (shift.status !== "upcoming") {
    res.status(409).json({ error: "Conflict", message: "This shift is no longer open" });
    return;
  }

  const myLevel = (await getEmployeeMaxLevel(userId)) ?? 0;
  if (myLevel < shift.requiredLicenseLevel) {
    res.status(403).json({
      error: "Forbidden",
      message: `This shift requires Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}. Your highest valid licence is ${myLevel === 0 ? "none" : `Level ${myLevel}`}.`,
    });
    return;
  }

  // Race-safe atomic claim: lock the parent shift row inside a transaction so
  // concurrent claims serialize on it; the unique index on (shift_id, employee_id)
  // prevents duplicate assignments. Returns null when full or already-assigned.
  let assignment: typeof shiftAssignmentsTable.$inferSelect | undefined;
  let alreadyAssigned = false;
  try {
    assignment = await db.transaction(async (tx) => {
      // Lock the shift row so only one concurrent claim can proceed at a time.
      const locked = await tx.execute(sql`
        SELECT headcount FROM shifts WHERE id = ${shiftId}::uuid FOR UPDATE
      `);
      const lockedRow = (locked as any).rows?.[0];
      if (!lockedRow) return undefined;
      const headcount: number = lockedRow.headcount;

      const countRes = await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM shift_assignments WHERE shift_id = ${shiftId}::uuid
      `);
      const filled: number = (countRes as any).rows?.[0]?.c ?? 0;
      if (filled >= headcount) return undefined;

      try {
        const inserted = await tx.execute(sql`
          INSERT INTO shift_assignments (shift_id, employee_id, status)
          VALUES (${shiftId}::uuid, ${userId}::uuid, 'accepted')
          RETURNING id, shift_id, employee_id, status, created_at, updated_at
        `);
        const row = (inserted as any).rows?.[0];
        return {
          id: row.id,
          shiftId: row.shift_id,
          employeeId: row.employee_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        } as any;
      } catch (e: any) {
        // Unique violation = user already signed up
        if (e?.code === "23505") {
          alreadyAssigned = true;
          return undefined;
        }
        throw e;
      }
    });
  } catch (err) {
    req.log.error({ err }, "claim shift insert failed");
    res.status(500).json({ error: "Internal", message: "Could not sign up" });
    return;
  }

  if (!assignment) {
    if (alreadyAssigned) {
      res.status(409).json({ error: "Conflict", message: "You're already signed up for this shift" });
    } else {
      res.status(409).json({ error: "Conflict", message: "This shift is fully staffed" });
    }
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  res.status(201).json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.post("/shifts/:id/assignments", requireAdmin, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { employeeId } = req.body;
  if (!employeeId) { res.status(400).json({ error: "Bad Request", message: "employeeId required" }); return; }

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  const empLevel = (await getEmployeeMaxLevel(employeeId)) ?? 0;
  if (empLevel < shift.requiredLicenseLevel) {
    res.status(403).json({
      error: "Forbidden",
      message: `Employee's highest valid licence (${empLevel === 0 ? "none" : `Level ${empLevel}`}) does not meet the shift requirement (Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}).`,
    });
    return;
  }

  const [assignment] = await db.insert(shiftAssignmentsTable).values({ shiftId, employeeId, status: "pending" }).returning();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));

  // Send push notification to the assigned employee
  try {
    const { sendPushToUsers } = await import("../lib/push");
    const start = new Date(shift.startTime).toLocaleString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    await sendPushToUsers([employeeId], {
      title: "📋 New Shift Assigned",
      body: `You've been assigned to ${shift.title} on ${start}`,
      data: { type: "shift_assigned", shiftId },
    });
  } catch (err) {
    req.log.warn({ err }, "Failed to send assignment push");
  }

  res.status(201).json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.put("/shifts/:id/assignments/:assignmentId", requireAuth, async (req, res): Promise<void> => {
  const assignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const { status } = req.body;
  if (!status) { res.status(400).json({ error: "Bad Request", message: "status required" }); return; }

  const [existing] = await db.select().from(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.id, assignmentId));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }

  // Non-admins can only modify their own assignments.
  if (req.user!.role !== "admin" && existing.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden", message: "You can only update your own assignments" });
    return;
  }

  const [assignment] = await db.update(shiftAssignmentsTable).set({ status }).where(eq(shiftAssignmentsTable.id, assignmentId)).returning();
  if (!assignment) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, assignment.employeeId));
  res.json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

export default router;
