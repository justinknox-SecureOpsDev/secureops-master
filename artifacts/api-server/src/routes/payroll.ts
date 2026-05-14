import { Router, type IRouter } from "express";
import { eq, and, gte, lte, lt, sql } from "drizzle-orm";
import { db, payrollEntriesTable, usersTable, timeEntriesTable, shiftsTable, sitesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

router.get("/payroll", requireAdmin, async (req, res): Promise<void> => {
  const { employeeId, siteId, status, periodStart, periodEnd } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (employeeId) conditions.push(eq(payrollEntriesTable.employeeId, employeeId));
  if (siteId) conditions.push(eq(payrollEntriesTable.siteId, siteId));
  if (status) conditions.push(eq(payrollEntriesTable.status, status));
  if (periodStart) conditions.push(gte(payrollEntriesTable.periodStart, periodStart));
  if (periodEnd) conditions.push(lte(payrollEntriesTable.periodEnd, periodEnd));

  const rows = await db
    .select({
      id: payrollEntriesTable.id,
      employeeId: payrollEntriesTable.employeeId,
      siteId: payrollEntriesTable.siteId,
      siteName: sitesTable.name,
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
    .leftJoin(sitesTable, eq(payrollEntriesTable.siteId, sitesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows);
});

// Generate weekly payroll for a site from APPROVED time entries.
// Aggregates per (employee × shift payRate) and produces one payroll entry per employee for that week.
router.post("/payroll/generate", requireAdmin, async (req, res): Promise<void> => {
  const { siteId, weekStart } = req.body;
  if (!siteId || !weekStart) {
    res.status(400).json({ error: "Bad Request", message: "siteId and weekStart required" });
    return;
  }
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) { res.status(400).json({ error: "Bad Request", message: "weekStart must be YYYY-MM-DD" }); return; }
  const end = addDays(start, 7);

  // Pull approved time entries at this site for the week.
  const entries = await db
    .select({
      employeeId: timeEntriesTable.employeeId,
      hoursWorked: timeEntriesTable.hoursWorked,
      payRate: shiftsTable.payRate,
    })
    .from(timeEntriesTable)
    .innerJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .where(and(
      eq(shiftsTable.siteId, siteId),
      eq(timeEntriesTable.approvalStatus, "approved"),
      gte(timeEntriesTable.clockInTime, start),
      lt(timeEntriesTable.clockInTime, end),
    ));

  // Aggregate per employee: total hours and pay (sum of hours × shift payRate per entry).
  type Agg = { totalHours: number; gross: number };
  const perEmployee = new Map<string, Agg>();
  for (const e of entries) {
    const hours = parseFloat(String(e.hoursWorked || "0"));
    const rate = parseFloat(String(e.payRate || "0"));
    const cur = perEmployee.get(e.employeeId) ?? { totalHours: 0, gross: 0 };
    cur.totalHours += hours;
    cur.gross += hours * rate;
    perEmployee.set(e.employeeId, cur);
  }

  if (perEmployee.size === 0) {
    res.status(200).json([]);
    return;
  }

  const periodStart = isoDate(start);
  const periodEnd = isoDate(addDays(start, 6));
  const created: any[] = [];

  for (const [employeeId, agg] of perEmployee) {
    const totalHours = Math.round(agg.totalHours * 100) / 100;
    const gross = Math.round(agg.gross * 100) / 100;
    const tax = Math.round(gross * 0.2 * 100) / 100;
    const net = Math.round((gross - tax) * 100) / 100;
    const avgRate = totalHours > 0 ? Math.round((gross / totalHours) * 100) / 100 : 0;

    // Upsert by (employee, site, periodStart) — a re-generate replaces the totals.
    const [row] = await db.insert(payrollEntriesTable).values({
      employeeId,
      siteId,
      periodStart,
      periodEnd,
      totalHours: String(totalHours),
      hourlyRate: String(avgRate),
      grossPay: String(gross),
      tax: String(tax),
      netPay: String(net),
      status: "pending",
    }).onConflictDoUpdate({
      target: [payrollEntriesTable.employeeId, payrollEntriesTable.siteId, payrollEntriesTable.periodStart],
      set: {
        totalHours: String(totalHours),
        hourlyRate: String(avgRate),
        grossPay: String(gross),
        tax: String(tax),
        netPay: String(net),
        updatedAt: new Date(),
      },
    }).returning();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));
    const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, siteId));
    created.push({
      ...row,
      employeeName: user ? `${user.firstName} ${user.lastName}` : null,
      siteName: site?.name ?? null,
    });
  }

  res.status(201).json(created);
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
