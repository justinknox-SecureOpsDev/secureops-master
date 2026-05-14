import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { db, payrollEntriesTable, usersTable, timeEntriesTable, employeesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/payroll", requireAdmin, async (req, res): Promise<void> => {
  const { employeeId, status, periodStart, periodEnd } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (employeeId) conditions.push(eq(payrollEntriesTable.employeeId, employeeId));
  if (status) conditions.push(eq(payrollEntriesTable.status, status));
  if (periodStart) conditions.push(gte(payrollEntriesTable.periodStart, periodStart));
  if (periodEnd) conditions.push(lte(payrollEntriesTable.periodEnd, periodEnd));

  const rows = await db
    .select({
      id: payrollEntriesTable.id,
      employeeId: payrollEntriesTable.employeeId,
      periodStart: payrollEntriesTable.periodStart,
      periodEnd: payrollEntriesTable.periodEnd,
      totalHours: payrollEntriesTable.totalHours,
      hourlyRate: payrollEntriesTable.hourlyRate,
      grossPay: payrollEntriesTable.grossPay,
      tax: payrollEntriesTable.tax,
      netPay: payrollEntriesTable.netPay,
      status: payrollEntriesTable.status,
      paidAt: payrollEntriesTable.paidAt,
      notes: payrollEntriesTable.notes,
      createdAt: payrollEntriesTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(payrollEntriesTable)
    .leftJoin(usersTable, eq(payrollEntriesTable.employeeId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows);
});

router.post("/payroll", requireAdmin, async (req, res): Promise<void> => {
  const { employeeId, periodStart, periodEnd, notes } = req.body;
  if (!employeeId || !periodStart || !periodEnd) {
    res.status(400).json({ error: "Bad Request", message: "employeeId, periodStart, periodEnd required" });
    return;
  }

  const timeEntries = await db
    .select()
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.employeeId, employeeId),
        gte(timeEntriesTable.clockInTime, new Date(periodStart)),
        lte(timeEntriesTable.clockInTime, new Date(periodEnd))
      )
    );

  const totalHours = timeEntries.reduce((sum, e) => sum + parseFloat(String(e.hoursWorked || 0)), 0);

  const [empRow] = await db
    .select({ hourlyRate: employeesTable.hourlyRate })
    .from(employeesTable)
    .where(eq(employeesTable.userId, employeeId));

  const hourlyRate = parseFloat(String(empRow?.hourlyRate || 0));
  const grossPay = Math.round(totalHours * hourlyRate * 100) / 100;
  const tax = Math.round(grossPay * 0.2 * 100) / 100;
  const netPay = Math.round((grossPay - tax) * 100) / 100;

  const [entry] = await db.insert(payrollEntriesTable).values({
    employeeId,
    periodStart,
    periodEnd,
    totalHours: String(Math.round(totalHours * 100) / 100),
    hourlyRate: String(hourlyRate),
    grossPay: String(grossPay),
    tax: String(tax),
    netPay: String(netPay),
    status: "pending",
    notes: notes || null,
  }).returning();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));
  res.status(201).json({ ...entry, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.put("/payroll/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { status, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (status) {
    updates.status = status;
    if (status === "paid") updates.paidAt = new Date();
  }
  if (notes !== undefined) updates.notes = notes;

  const [entry] = await db.update(payrollEntriesTable).set(updates).where(eq(payrollEntriesTable.id, id)).returning();
  if (!entry) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, entry.employeeId));
  res.json({ ...entry, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

export default router;
