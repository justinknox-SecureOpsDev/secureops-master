import { Router, type IRouter } from "express";
import { eq, and, gte, lte, lt, sql, inArray } from "drizzle-orm";
import { db, payrollEntriesTable, usersTable, employeesTable, timeEntriesTable, shiftsTable, sitesTable } from "@workspace/db";
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

// =============================================================================
// PAY RUN — execute a batch of payroll entries.
//
// Three steps an admin walks through on the Pay Run page:
//   1. POST /payroll/pay-run/preview      — load full detail + bank info + warnings
//   2. POST /payroll/pay-run/export-csv   — download ACH CSV, mark as "processed"
//   3. POST /payroll/pay-run/mark-paid    — confirm bank settled, mark as "paid"
//
// /payroll/pay-run/stripe is scaffolded but disabled unless STRIPE_CONNECT_ENABLED=true.
// =============================================================================

type PayRunRow = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeEmail: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: string;
  hourlyRate: string;
  grossPay: string;
  tax: string;
  netPay: string;
  status: string;
  paidAt: Date | null;
  paidMethod: string | null;
  paymentReference: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankBsb: string | null;
  directDepositConsent: boolean | null;
  warnings: string[];
};

async function loadPayRunRows(ids: string[]): Promise<PayRunRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: payrollEntriesTable.id,
      employeeId: payrollEntriesTable.employeeId,
      employeeName: sql<string | null>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      employeeEmail: usersTable.email,
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
      paidMethod: payrollEntriesTable.paidMethod,
      paymentReference: payrollEntriesTable.paymentReference,
      bankAccountName: employeesTable.bankAccountName,
      bankAccountNumber: employeesTable.bankAccountNumber,
      bankBsb: employeesTable.bankBsb,
      directDepositConsent: employeesTable.directDepositConsent,
    })
    .from(payrollEntriesTable)
    .leftJoin(usersTable, eq(payrollEntriesTable.employeeId, usersTable.id))
    .leftJoin(sitesTable, eq(payrollEntriesTable.siteId, sitesTable.id))
    .leftJoin(employeesTable, eq(employeesTable.userId, payrollEntriesTable.employeeId))
    .where(inArray(payrollEntriesTable.id, ids));

  return rows.map((r) => {
    const warnings: string[] = [];
    if (!r.bankAccountNumber) warnings.push("Missing bank account number");
    if (!r.bankBsb) warnings.push("Missing routing/sort code");
    if (!r.bankAccountName) warnings.push("Missing bank account name");
    if (r.directDepositConsent !== true) warnings.push("Direct-deposit consent not on file");
    if (Number(r.netPay) <= 0) warnings.push("Net pay is zero or negative");
    return { ...r, warnings };
  });
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Neutralise spreadsheet formula-injection prefixes (=, +, -, @, |, tab, CR).
  // Prefixing with a single quote is the standard defence recognised by Excel,
  // LibreOffice Calc, and Google Sheets; the quote is kept inside the quoted
  // field so it does not appear in the displayed cell value.
  if (/^[=+\-@|]/.test(s) || s.startsWith("\t") || s.startsWith("\r")) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.post("/payroll/pay-run/preview", requireAdmin, async (req, res): Promise<void> => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const rows = await loadPayRunRows(ids);
  const totals = rows.reduce(
    (acc, r) => {
      acc.gross += Number(r.grossPay);
      acc.tax += Number(r.tax);
      acc.net += Number(r.netPay);
      return acc;
    },
    { gross: 0, tax: 0, net: 0 },
  );
  const round2 = (n: number) => Math.round(n * 100) / 100;
  res.json({
    rows,
    counts: {
      total: rows.length,
      payable: rows.filter((r) => r.warnings.length === 0 && r.status !== "paid").length,
      withWarnings: rows.filter((r) => r.warnings.length > 0).length,
      alreadyPaid: rows.filter((r) => r.status === "paid").length,
    },
    totals: { gross: round2(totals.gross), tax: round2(totals.tax), net: round2(totals.net) },
  });
});

router.post("/payroll/pay-run/export-csv", requireAdmin, async (req, res): Promise<void> => {
  const { ids, batchReference } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const rows = await loadPayRunRows(ids);
  const payable = rows.filter((r) => r.status !== "paid" && r.warnings.length === 0);
  if (payable.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No rows are payable (already paid or missing bank info)." });
    return;
  }

  const batchId = (batchReference && String(batchReference).trim()) || `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  // Standard ACH-style CSV. Most US business banks accept this column shape on
  // their bulk-upload portal; remap on their side if not exact.
  const header = [
    "Employee Name", "Account Name", "Routing Number", "Account Number",
    "Amount (USD)", "Pay Period Start", "Pay Period End", "Site", "Reference", "Memo",
  ].join(",");
  const lines = payable.map((r) =>
    [
      csvEscape(r.employeeName),
      csvEscape(r.bankAccountName),
      csvEscape(r.bankBsb),
      csvEscape(r.bankAccountNumber),
      csvEscape(Number(r.netPay).toFixed(2)),
      csvEscape(r.periodStart),
      csvEscape(r.periodEnd),
      csvEscape(r.siteName),
      csvEscape(`${batchId}-${r.id.slice(0, 8)}`),
      csvEscape(`WCSG payroll ${r.periodStart} → ${r.periodEnd}`),
    ].join(","),
  );
  const csv = [header, ...lines].join("\r\n") + "\r\n";

  // Mark each payable row as processed (pending → processed). Don't touch already-processed rows' originals.
  await db
    .update(payrollEntriesTable)
    .set({
      status: "processed",
      paidMethod: "ach_csv",
      paymentReference: batchId,
      paidBy: req.user!.userId,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(payrollEntriesTable.id, payable.map((r) => r.id)),
      eq(payrollEntriesTable.status, "pending"),
    ));

  const filename = `wcsg-payroll-${batchId}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Pay-Run-Batch", batchId);
  res.setHeader("X-Pay-Run-Count", String(payable.length));
  res.setHeader("X-Pay-Run-Skipped", String(rows.length - payable.length));
  res.status(200).send(csv);
});

router.post("/payroll/pay-run/mark-paid", requireAdmin, async (req, res): Promise<void> => {
  const { ids, paymentReference, method } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const safeMethod = ["manual", "ach_csv", "stripe"].includes(method) ? method : "manual";
  // Only flip rows that are NOT already paid — guards against accidental
  // double-write (and preserves the original paidAt / batch reference).
  const updated = await db
    .update(payrollEntriesTable)
    .set({
      status: "paid",
      paidAt: new Date(),
      paidBy: req.user!.userId,
      paidMethod: safeMethod,
      paymentReference: paymentReference ? String(paymentReference) : sql`coalesce(${payrollEntriesTable.paymentReference}, NULL)`,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(payrollEntriesTable.id, ids),
      sql`${payrollEntriesTable.status} <> 'paid'`,
    ))
    .returning({ id: payrollEntriesTable.id });
  res.json({ marked: updated.length, skipped: ids.length - updated.length, ids: updated.map((r) => r.id) });
});

router.post("/payroll/pay-run/stripe", requireAdmin, async (req, res): Promise<void> => {
  if (process.env.STRIPE_CONNECT_ENABLED !== "true") {
    res.status(501).json({
      error: "Not Implemented",
      message: "Stripe Connect payments are scaffolded but disabled. Set STRIPE_CONNECT_ENABLED=true and provide STRIPE_SECRET_KEY + each employee's stripeAccountId to enable.",
      configured: false,
    });
    return;
  }
  // Real implementation would: 1) load rows, 2) for each, create a Transfer
  // to the employee's connected account via stripe.transfers.create(), 3) on
  // success store stripeTransferId + mark paid.  Left as TODO until enabled.
  res.status(501).json({ error: "Not Implemented", message: "Stripe Connect transfer logic not wired yet — set up connected accounts first." });
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
