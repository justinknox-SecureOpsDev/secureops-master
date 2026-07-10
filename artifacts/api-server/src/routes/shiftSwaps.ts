import { Router } from "express";
import { z } from "zod/v4";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  shiftSwapRequestsTable,
  shiftAssignmentsTable,
  shiftsTable,
  sitesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { getEffectiveLevel, isWorkerRole, WORKER_ROLES } from "../lib/eligibility";

const router = Router();

async function pushSafely(userIds: string[], title: string, body: string, data?: Record<string, unknown>) {
  try {
    const { sendPushToUsers } = await import("../lib/push");
    await sendPushToUsers(userIds, { title, body, data });
  } catch {
    /* no-op — push is best-effort */
  }
}

async function adminUserIds(): Promise<string[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.role, "admin"), eq(usersTable.status, "active")));
  return rows.map((r) => r.id);
}

// ---------- Officer: create swap request ----------
const createSchema = z.object({
  assignmentId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

router.post("/shifts/swap-requests", requireAuth, async (req, res): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { assignmentId, targetUserId, reason } = parsed.data;
  const me = req.user!.userId;

  if (targetUserId === me) {
    res.status(400).json({ error: "Bad Request", message: "Cannot swap with yourself" });
    return;
  }

  const [assignment] = await db
    .select({
      id: shiftAssignmentsTable.id,
      employeeId: shiftAssignmentsTable.employeeId,
      status: shiftAssignmentsTable.status,
      shiftId: shiftAssignmentsTable.shiftId,
    })
    .from(shiftAssignmentsTable)
    .where(eq(shiftAssignmentsTable.id, assignmentId));
  if (!assignment) {
    res.status(404).json({ error: "Not Found", message: "Assignment not found" });
    return;
  }
  if (assignment.employeeId !== me) {
    res.status(403).json({ error: "Forbidden", message: "You do not own this assignment" });
    return;
  }
  if (assignment.status !== "accepted") {
    res.status(400).json({ error: "Bad Request", message: "Only accepted assignments can be swapped" });
    return;
  }

  const [shift] = await db
    .select({
      id: shiftsTable.id,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
      siteId: shiftsTable.siteId,
    })
    .from(shiftsTable)
    .where(eq(shiftsTable.id, assignment.shiftId));
  if (!shift) {
    res.status(404).json({ error: "Not Found", message: "Shift not found" });
    return;
  }
  if (shift.startTime.getTime() <= Date.now()) {
    res.status(400).json({ error: "Bad Request", message: "Shift has already started" });
    return;
  }

  const [target] = await db
    .select({ id: usersTable.id, status: usersTable.status, role: usersTable.role, firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, targetUserId));
  if (!target || target.status !== "active" || !isWorkerRole(target.role)) {
    res.status(400).json({ error: "Bad Request", message: "Target officer is not eligible" });
    return;
  }

  const required = shift.requiredLicenseLevel;
  const targetMax = await getEffectiveLevel(targetUserId);
  if (targetMax < required) {
    res.status(400).json({
      error: "Bad Request",
      message: `Target officer does not hold the required license (L${shift.requiredLicenseLevel})`,
    });
    return;
  }

  // No two open swaps for the same assignment.
  const [existing] = await db
    .select({ id: shiftSwapRequestsTable.id })
    .from(shiftSwapRequestsTable)
    .where(and(
      eq(shiftSwapRequestsTable.assignmentId, assignmentId),
      inArray(shiftSwapRequestsTable.status, ["pending", "accepted"]),
    ));
  if (existing) {
    res.status(409).json({ error: "Conflict", message: "An open swap request already exists for this shift" });
    return;
  }

  const [me_] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, me));

  const [created] = await db
    .insert(shiftSwapRequestsTable)
    .values({
      assignmentId,
      requestingUserId: me,
      targetUserId,
      reason: reason ?? null,
    })
    .returning();

  void pushSafely(
    [targetUserId],
    "Shift swap requested",
    `${me_?.firstName ?? "An officer"} ${me_?.lastName ?? ""} would like you to cover their shift.`.trim(),
    { type: "swap-request", swapId: created.id, shiftId: shift.id },
  );

  res.status(201).json(created);
});

// ---------- Officer: list eligible swap targets for one of my assignments ----------
router.get("/me/swap-targets/:assignmentId", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const [assignment] = await db
    .select({ employeeId: shiftAssignmentsTable.employeeId, shiftId: shiftAssignmentsTable.shiftId, status: shiftAssignmentsTable.status })
    .from(shiftAssignmentsTable)
    .where(eq(shiftAssignmentsTable.id, String(req.params.assignmentId)));
  if (!assignment || assignment.employeeId !== me) {
    res.status(404).json({ error: "Not Found", message: "Assignment not found" });
    return;
  }
  // Mirror the preconditions of POST /shifts/swap-requests so the UI cannot
  // offer a target picker for assignments the server would never accept.
  if (assignment.status !== "accepted") {
    res.status(400).json({ error: "Bad Request", message: "Only accepted assignments can be swapped" });
    return;
  }
  const [shift] = await db
    .select({ requiredLicenseLevel: shiftsTable.requiredLicenseLevel, startTime: shiftsTable.startTime })
    .from(shiftsTable)
    .where(eq(shiftsTable.id, assignment.shiftId));
  if (!shift) {
    res.status(404).json({ error: "Not Found", message: "Shift not found" });
    return;
  }
  if (shift.startTime.getTime() <= Date.now()) {
    res.status(400).json({ error: "Bad Request", message: "Shift has already started" });
    return;
  }
  const required = shift.requiredLicenseLevel;

  const employees = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(and(inArray(usersTable.role, [...WORKER_ROLES]), eq(usersTable.status, "active")));

  // Minimal fields only — no email — to limit directory exposure to peers.
  const eligible: Array<{ id: string; firstName: string; lastName: string }> = [];
  for (const e of employees) {
    if (e.id === me) continue;
    const lvl = await getEffectiveLevel(e.id);
    if (lvl >= required) eligible.push(e);
  }
  res.json(eligible);
});

// ---------- Officer: list my swap requests ----------
router.get("/me/swap-requests", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const rows = await db
    .select({
      id: shiftSwapRequestsTable.id,
      assignmentId: shiftSwapRequestsTable.assignmentId,
      requestingUserId: shiftSwapRequestsTable.requestingUserId,
      targetUserId: shiftSwapRequestsTable.targetUserId,
      status: shiftSwapRequestsTable.status,
      reason: shiftSwapRequestsTable.reason,
      createdAt: shiftSwapRequestsTable.createdAt,
      decidedAt: shiftSwapRequestsTable.decidedAt,
      shiftId: shiftsTable.id,
      shiftStart: shiftsTable.startTime,
      shiftEnd: shiftsTable.endTime,
      siteName: sitesTable.name,
      requesterFirstName: usersTable.firstName,
      requesterLastName: usersTable.lastName,
    })
    .from(shiftSwapRequestsTable)
    .leftJoin(shiftAssignmentsTable, eq(shiftAssignmentsTable.id, shiftSwapRequestsTable.assignmentId))
    .leftJoin(shiftsTable, eq(shiftsTable.id, shiftAssignmentsTable.shiftId))
    .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
    .leftJoin(usersTable, eq(usersTable.id, shiftSwapRequestsTable.requestingUserId))
    .where(or(eq(shiftSwapRequestsTable.requestingUserId, me), eq(shiftSwapRequestsTable.targetUserId, me)))
    .orderBy(sql`${shiftSwapRequestsTable.createdAt} desc`);
  res.json(rows);
});

// ---------- Officer (target): respond accept / decline ----------
const respondSchema = z.object({ status: z.enum(["accepted", "declined"]) });

router.put("/shifts/swap-requests/:id/respond", requireAuth, async (req, res): Promise<void> => {
  const parsed = respondSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: "status must be accepted or declined" });
    return;
  }
  const me = req.user!.userId;

  const [swap] = await db
    .select()
    .from(shiftSwapRequestsTable)
    .where(eq(shiftSwapRequestsTable.id, String(req.params.id)));
  if (!swap) {
    res.status(404).json({ error: "Not Found", message: "Swap request not found" });
    return;
  }
  if (swap.targetUserId !== me) {
    res.status(403).json({ error: "Forbidden", message: "Only the target officer can respond" });
    return;
  }
  if (swap.status !== "pending") {
    res.status(409).json({ error: "Conflict", message: `Cannot respond to ${swap.status} request` });
    return;
  }

  const [updated] = await db
    .update(shiftSwapRequestsTable)
    .set({ status: parsed.data.status, decidedAt: new Date() })
    .where(eq(shiftSwapRequestsTable.id, swap.id))
    .returning();

  // Notify requester + (when accepted) admins for approval.
  void pushSafely(
    [swap.requestingUserId],
    parsed.data.status === "accepted" ? "Swap accepted" : "Swap declined",
    parsed.data.status === "accepted"
      ? "Your swap was accepted. Awaiting admin approval."
      : "Your swap was declined.",
    { type: "swap-update", swapId: swap.id },
  );
  if (parsed.data.status === "accepted") {
    const admins = await adminUserIds();
    void pushSafely(admins, "Shift swap awaiting approval", "An officer-to-officer swap is ready for your review.", {
      type: "swap-pending-approval",
      swapId: swap.id,
    });
  }

  res.json(updated);
});

// ---------- Officer (requester): cancel ----------
router.post("/shifts/swap-requests/:id/cancel", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const [swap] = await db
    .select()
    .from(shiftSwapRequestsTable)
    .where(eq(shiftSwapRequestsTable.id, String(req.params.id)));
  if (!swap) {
    res.status(404).json({ error: "Not Found", message: "Swap request not found" });
    return;
  }
  if (swap.requestingUserId !== me) {
    res.status(403).json({ error: "Forbidden", message: "Only the requester can cancel" });
    return;
  }
  if (!["pending", "accepted"].includes(swap.status)) {
    res.status(409).json({ error: "Conflict", message: `Cannot cancel ${swap.status} request` });
    return;
  }
  const [updated] = await db
    .update(shiftSwapRequestsTable)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(eq(shiftSwapRequestsTable.id, swap.id))
    .returning();
  void pushSafely([swap.targetUserId], "Swap cancelled", "The swap request was cancelled.", {
    type: "swap-cancelled",
    swapId: swap.id,
  });
  res.json(updated);
});

// ---------- Admin: list swaps ----------
router.get("/admin/swap-requests", requireAdmin, async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const where = status ? eq(shiftSwapRequestsTable.status, status) : undefined;

  const requester = { ...usersTable, _label: "requester" };
  const target = { ...usersTable, _label: "target" };

  const rows = await db.execute(sql`
    select
      ssr.id, ssr.status, ssr.reason, ssr.created_at, ssr.decided_at,
      ssr.requesting_user_id, ssr.target_user_id, ssr.assignment_id,
      sa.shift_id,
      s.start_time, s.end_time, s.required_license_level,
      st.name as site_name,
      ru.first_name as requester_first_name, ru.last_name as requester_last_name,
      tu.first_name as target_first_name,    tu.last_name as target_last_name
    from shift_swap_requests ssr
    left join shift_assignments sa on sa.id = ssr.assignment_id
    left join shifts s             on s.id  = sa.shift_id
    left join sites st             on st.id = s.site_id
    left join users ru             on ru.id = ssr.requesting_user_id
    left join users tu             on tu.id = ssr.target_user_id
    ${where ? sql`where ssr.status = ${status}` : sql``}
    order by ssr.created_at desc
    limit 500
  `);
  res.json(rows.rows ?? rows);
});

// ---------- Admin: approve (atomic) ----------
router.post("/admin/swap-requests/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const adminId = req.user!.userId;
  try {
    const result = await db.transaction(async (tx) => {
      const [swap] = await tx
        .select()
        .from(shiftSwapRequestsTable)
        .where(eq(shiftSwapRequestsTable.id, String(req.params.id)))
        .for("update");
      if (!swap) return { code: 404 as const, body: { error: "Not Found", message: "Swap request not found" } };
      if (swap.status !== "accepted")
        return { code: 409 as const, body: { error: "Conflict", message: `Cannot approve ${swap.status} request` } };

      const [assignment] = await tx
        .select()
        .from(shiftAssignmentsTable)
        .where(eq(shiftAssignmentsTable.id, swap.assignmentId))
        .for("update");
      if (!assignment)
        return { code: 410 as const, body: { error: "Gone", message: "Original assignment no longer exists" } };

      // Re-validate target & shift inside the transaction — eligibility may
      // have changed between accept and approve (license expired, account
      // deactivated, shift already started).
      const [shiftRow] = await tx
        .select({ startTime: shiftsTable.startTime, requiredLicenseLevel: shiftsTable.requiredLicenseLevel })
        .from(shiftsTable)
        .where(eq(shiftsTable.id, assignment.shiftId));
      if (!shiftRow)
        return { code: 410 as const, body: { error: "Gone", message: "Shift no longer exists" } };
      if (shiftRow.startTime.getTime() <= Date.now())
        return { code: 409 as const, body: { error: "Conflict", message: "Shift has already started" } };

      const [targetUser] = await tx
        .select({ status: usersTable.status, role: usersTable.role })
        .from(usersTable)
        .where(eq(usersTable.id, swap.targetUserId));
      if (!targetUser || !isWorkerRole(targetUser.role) || targetUser.status !== "active")
        return { code: 409 as const, body: { error: "Conflict", message: "Target officer is no longer eligible" } };

      const required = shiftRow.requiredLicenseLevel;
      const targetMax = await getEffectiveLevel(swap.targetUserId);
      if (targetMax < required)
        return { code: 409 as const, body: { error: "Conflict", message: "Target officer no longer holds the required license" } };

      // Replace requester's assignment with target's assignment in one tx.
      await tx.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.id, assignment.id));
      await tx
        .insert(shiftAssignmentsTable)
        .values({ shiftId: assignment.shiftId, employeeId: swap.targetUserId, status: "accepted" });

      const [updated] = await tx
        .update(shiftSwapRequestsTable)
        .set({ status: "approved", decidedAt: new Date(), adminApproverId: adminId })
        .where(eq(shiftSwapRequestsTable.id, swap.id))
        .returning();
      return { code: 200 as const, body: updated, swap };
    });

    if (result.code !== 200) {
      res.status(result.code).json(result.body);
      return;
    }
    void pushSafely(
      [result.swap.requestingUserId, result.swap.targetUserId],
      "Shift swap approved",
      "An admin approved the shift swap. The new assignment is in place.",
      { type: "swap-approved", swapId: result.swap.id },
    );
    res.json(result.body);
  } catch (err) {
    req.log.error({ err }, "Approve swap failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not approve swap" });
  }
});

// ---------- Admin: reject ----------
router.post("/admin/swap-requests/:id/reject", requireAdmin, async (req, res): Promise<void> => {
  const adminId = req.user!.userId;
  const [swap] = await db
    .select()
    .from(shiftSwapRequestsTable)
    .where(eq(shiftSwapRequestsTable.id, String(req.params.id)));
  if (!swap) {
    res.status(404).json({ error: "Not Found", message: "Swap request not found" });
    return;
  }
  if (!["pending", "accepted"].includes(swap.status)) {
    res.status(409).json({ error: "Conflict", message: `Cannot reject ${swap.status} request` });
    return;
  }
  const [updated] = await db
    .update(shiftSwapRequestsTable)
    .set({ status: "rejected", decidedAt: new Date(), adminApproverId: adminId })
    .where(eq(shiftSwapRequestsTable.id, swap.id))
    .returning();
  void pushSafely(
    [swap.requestingUserId, swap.targetUserId],
    "Shift swap rejected",
    "An admin rejected the shift swap.",
    { type: "swap-rejected", swapId: swap.id },
  );
  res.json(updated);
});

export default router;
