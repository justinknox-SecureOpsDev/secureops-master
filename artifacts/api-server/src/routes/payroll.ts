import { Router, type IRouter } from "express";
import { eq, and, gte, lte, lt, sql, inArray, desc } from "drizzle-orm";
import { db, payrollEntriesTable, usersTable, employeesTable, timeEntriesTable, shiftsTable, sitesTable, auditLogsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { randomUUID } from "node:crypto";
// (employeesTable + sitesTable + auditLogsTable used by board endpoint below)
import { requireAdmin } from "../middlewares/auth";
import { getFederalHolidayName, HOLIDAY_PAY_MULTIPLIER } from "../lib/holidays";
import { requireFeature } from "../lib/features";
import { submitMultipayment, getPaymentStatusByCustomerRef, mapRowToInstruction, isPncConfigured } from "../lib/pncPayments";

const router: IRouter = Router();
router.use("/payroll", requireFeature("payroll"));

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
      paidMethod: payrollEntriesTable.paidMethod,
      paymentReference: payrollEntriesTable.paymentReference,
      notes: payrollEntriesTable.notes,
      createdAt: payrollEntriesTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(payrollEntriesTable)
    .leftJoin(usersTable, eq(payrollEntriesTable.employeeId, usersTable.id))
    .leftJoin(sitesTable, eq(payrollEntriesTable.siteId, sitesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  // 1099 contractors — no tax is withheld; net always equals gross. Normalise on
  // read so any legacy row stored with withholding still shows full gross.
  res.json(rows.map((r) => ({ ...r, tax: "0", netPay: r.grossPay })));
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
      clockInTime: timeEntriesTable.clockInTime,
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
    // Federal-holiday premium (1.5×): an entry clocked in on a US federal
    // holiday (in PAYROLL_TIMEZONE) earns time-and-a-half on the whole entry.
    // Round the premium rate to cents so it reconciles with the per-entry rate
    // surfaced elsewhere (Payroll Board, invoices) — rate × hours == gross.
    const effectiveRate = getFederalHolidayName(e.clockInTime)
      ? Math.round(rate * HOLIDAY_PAY_MULTIPLIER * 100) / 100
      : rate;
    const cur = perEmployee.get(e.employeeId) ?? { totalHours: 0, gross: 0 };
    cur.totalHours += hours;
    cur.gross += hours * effectiveRate;
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
    // 1099 contractors — no tax is withheld; net always equals gross.
    const tax = 0;
    const net = gross;
    const avgRate = totalHours > 0 ? Math.round((gross / totalHours) * 100) / 100 : 0;

    // Upsert by (employee, site, periodStart) — a re-generate replaces the
    // totals, but ONLY while the row is still 'pending'. Archived rows are
    // point-in-time snapshots and processed/paid rows are financial records;
    // rewriting either would silently corrupt them, so the conflict-update is
    // gated on status and non-pending rows are skipped from the response.
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
      setWhere: eq(payrollEntriesTable.status, "pending"),
    }).returning();
    if (!row) continue; // existing row is archived/processed/paid — left untouched
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
    // 1099 contractors — no tax is withheld; net always equals gross. Normalise on
    // read so any legacy row stored with withholding still pays full gross.
    const netPay = r.grossPay;
    const warnings: string[] = [];
    if (!r.bankAccountNumber) warnings.push("Missing bank account number");
    if (!r.bankBsb) warnings.push("Missing routing/sort code");
    if (!r.bankAccountName) warnings.push("Missing bank account name");
    if (r.directDepositConsent !== true) warnings.push("Direct-deposit consent not on file");
    if (Number(netPay) <= 0) warnings.push("Net pay is zero or negative");
    return { ...r, tax: "0", netPay, warnings };
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
      // Only "pending" rows are actually exportable; preview reflects that so the
      // count matches what Export will pay.
      payable: rows.filter((r) => r.status === "pending" && r.warnings.length === 0).length,
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
  // ONLY "pending" rows are exportable. A processed/paid row must never be
  // re-emitted into a new CSV (that would generate a duplicate outbound payment
  // file), and a payable row with warnings is not exported.
  const eligible = rows.filter((r) => r.status === "pending" && r.warnings.length === 0);
  if (eligible.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No rows are payable (must be pending, with bank info, and not already processed/paid)." });
    return;
  }

  const batchId = (batchReference && String(batchReference).trim()) || `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  // Concurrency-safe claim: atomically transition pending → processed and let
  // RETURNING tell us which rows THIS request actually won. The CSV is built
  // only from claimed rows, so two concurrent exports can never both emit a
  // payment line for the same entry (the loser's claim returns nothing).
  const claimed = await db
    .update(payrollEntriesTable)
    .set({
      status: "processed",
      paidMethod: "ach_csv",
      paymentReference: batchId,
      paidBy: req.user!.userId,
      // 1099 contractors — no tax withheld. Correct any legacy withholding on the
      // row at payment time so the ledger matches what the CSV actually pays.
      tax: "0",
      netPay: sql`${payrollEntriesTable.grossPay}`,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(payrollEntriesTable.id, eligible.map((r) => r.id)),
      eq(payrollEntriesTable.status, "pending"),
    ))
    .returning({ id: payrollEntriesTable.id });
  const claimedIds = new Set(claimed.map((c) => c.id));
  const payable = eligible.filter((r) => claimedIds.has(r.id));
  if (payable.length === 0) {
    res.status(409).json({ error: "Conflict", message: "Selected rows were already processed by another export." });
    return;
  }

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
  // Only rows that have reached a payable state can be confirmed paid:
  //   - "processed": the normal path (ACH CSV exported, awaiting bank confirm)
  //   - "pending":   direct manual payment without exporting a CSV
  // failed / paid are intentionally NOT mark-payable from here (a failed payment
  // needs investigation, and paid is already done — preserves original paidAt).
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
      inArray(payrollEntriesTable.status, ["pending", "processed"]),
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

// POST /payroll/pay-run/pnc — Submit a batch of pending payroll entries directly
// to PNC Bank via their multipayment API. Mirrors export-csv but sends to PNC
// instead of downloading a file.
//
// Concurrency safety: rows are atomically claimed to status='processing' BEFORE
// the outbound PNC call. Concurrent requests see those rows as non-pending and
// skip them, preventing duplicate bank submissions. On PNC success rows advance
// to 'processed'; on any failure they are rolled back to 'pending'.
router.post("/payroll/pay-run/pnc", requireAdmin, async (req, res): Promise<void> => {
  if (!isPncConfigured()) {
    res.status(503).json({
      error: "Service Unavailable",
      message: "PNC API credentials are not configured. Add PNC_CLIENT_ID, PNC_CLIENT_SECRET, PNC_INSTRUCTOR_ACCOUNT_NUMBER, and PNC_INSTRUCTOR_ROUTING_NUMBER to enable.",
      configured: false,
    });
    return;
  }

  const bodyParsed = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const { ids } = bodyParsed.data;

  const rows = await loadPayRunRows(ids);
  const pending = rows.filter((r) => r.status === "pending");

  if (pending.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No pending rows found in the selection." });
    return;
  }

  // Map rows to PNC instructions BEFORE claiming. Reject the whole batch if any
  // pending row is missing bank data (fail loudly, nothing touched in DB yet).
  type MappedInstruction = { rowId: string; instructionId: string; customerReference: string; instruction: import("../lib/pncPayments").PncInstruction };
  const mapped: MappedInstruction[] = [];
  const skipped: { rowId: string; reason: string }[] = [];

  for (const row of pending) {
    const result = mapRowToInstruction({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      bankAccountName: row.bankAccountName,
      bankAccountNumber: row.bankAccountNumber,
      bankBsb: row.bankBsb,
      netPay: row.netPay,
      periodStart: row.periodStart,
    });
    if (result.ok) {
      mapped.push({
        rowId: row.id,
        instructionId: result.instruction.instructionId,
        customerReference: result.customerReference,
        instruction: result.instruction,
      });
    } else {
      skipped.push({ rowId: row.id, reason: result.reason });
    }
  }

  if (mapped.length === 0) {
    res.status(422).json({
      error: "Unprocessable Entity",
      message: "All selected rows are missing required bank data.",
      skipped,
    });
    return;
  }

  if (skipped.length > 0) {
    res.status(422).json({
      error: "Unprocessable Entity",
      message: `${skipped.length} row(s) are missing bank data. Fix them or deselect before retrying.`,
      skipped,
    });
    return;
  }

  // ── Atomic claim: pending → processing ───────────────────────────────────────
  // Each row gets its own customerReference stored in paymentReference so that
  // the "Check PNC Status" button can query PNC's API by that reference.
  // The batch multipaymentId is a group identifier for the PNC API call only —
  // it is NOT stored in the DB (only in audit log metadata).
  // Per-row UPDATEs run inside a single transaction: concurrent requests that
  // win the race on a given row claim it; rows already claimed are skipped.
  const multipaymentId = randomUUID();

  type ClaimedRow = { id: string; customerReference: string };
  const claimed: ClaimedRow[] = await db.transaction(async (tx) => {
    const results: ClaimedRow[] = [];
    for (const m of mapped) {
      const rows = await tx
        .update(payrollEntriesTable)
        .set({
          status: "processing",
          paidMethod: "pnc_api",
          paymentReference: m.customerReference,
          paidBy: req.user!.userId,
          updatedAt: new Date(),
        })
        .where(and(
          eq(payrollEntriesTable.id, m.rowId),
          eq(payrollEntriesTable.status, "pending"),
        ))
        .returning({ id: payrollEntriesTable.id });
      if (rows.length > 0) {
        results.push({ id: rows[0]!.id, customerReference: m.customerReference });
      }
    }
    return results;
  });

  if (claimed.length === 0) {
    // Another concurrent request already claimed all these rows.
    res.status(409).json({
      error: "Conflict",
      message: "All selected rows are already being processed by another request. Refresh and try again.",
    });
    return;
  }

  const claimedSet = new Set(claimed.map((r) => r.id));
  const instructions = mapped
    .filter((m) => claimedSet.has(m.rowId))
    .map((m) => m.instruction);

  // ── PNC API call ─────────────────────────────────────────────────────────────
  let pncResult: Awaited<ReturnType<typeof submitMultipayment>>;
  try {
    pncResult = await submitMultipayment(multipaymentId, instructions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Transport-level failure — roll back to pending so the admin can retry.
    await db
      .update(payrollEntriesTable)
      .set({ status: "pending", paidMethod: null, paymentReference: null, paidBy: null, updatedAt: new Date() })
      .where(and(inArray(payrollEntriesTable.id, Array.from(claimedSet)), eq(payrollEntriesTable.status, "processing")))
      .catch(() => {});
    await db.insert(auditLogsTable).values({
      actorUserId: req.user!.userId,
      actorEmail: req.user!.email ?? null,
      actorRole: req.user!.role ?? null,
      action: "payroll.pnc.submit.error",
      targetTable: "payroll_entries",
      targetId: null,
      method: "POST",
      path: "/payroll/pay-run/pnc",
      statusCode: 502,
      metadata: JSON.stringify({ multipaymentId, rowCount: claimed.length, error: msg }),
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    }).catch(() => {});
    res.status(502).json({ error: "Bad Gateway", message: `PNC API error: ${msg}` });
    return;
  }

  if (!pncResult.ok) {
    // PNC rejected — roll back to pending so the admin can correct and retry.
    await db
      .update(payrollEntriesTable)
      .set({ status: "pending", paidMethod: null, paymentReference: null, paidBy: null, updatedAt: new Date() })
      .where(and(inArray(payrollEntriesTable.id, Array.from(claimedSet)), eq(payrollEntriesTable.status, "processing")))
      .catch(() => {});
    await db.insert(auditLogsTable).values({
      actorUserId: req.user!.userId,
      actorEmail: req.user!.email ?? null,
      actorRole: req.user!.role ?? null,
      action: "payroll.pnc.submit.rejected",
      targetTable: "payroll_entries",
      targetId: null,
      method: "POST",
      path: "/payroll/pay-run/pnc",
      statusCode: 502,
      metadata: JSON.stringify({ multipaymentId, rowCount: claimed.length, errors: pncResult.errors }),
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    }).catch(() => {});
    res.status(502).json({
      error: "Bad Gateway",
      message: "PNC rejected the payment batch. Rows rolled back to pending.",
      pncErrors: pncResult.errors,
      multipaymentId,
    });
    return;
  }

  // ── Advance processing → processed ───────────────────────────────────────────
  const finalised = await db
    .update(payrollEntriesTable)
    .set({
      status: "processed",
      tax: "0",
      netPay: sql`${payrollEntriesTable.grossPay}`,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(payrollEntriesTable.id, Array.from(claimedSet)),
      eq(payrollEntriesTable.status, "processing"),
    ))
    .returning({ id: payrollEntriesTable.id });

  await db.insert(auditLogsTable).values({
    actorUserId: req.user!.userId,
    actorEmail: req.user!.email ?? null,
    actorRole: req.user!.role ?? null,
    action: "payroll.pnc.submit.success",
    targetTable: "payroll_entries",
    targetId: null,
    method: "POST",
    path: "/payroll/pay-run/pnc",
    statusCode: 200,
    metadata: JSON.stringify({ multipaymentId, rowCount: finalised.length }),
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  }).catch(() => {});

  res.json({
    ok: true,
    multipaymentId,
    processed: finalised.length,
    skipped: claimed.length - finalised.length,
  });
});

// GET /payroll/pay-run/pnc-status — Proxy a live PNC status check for a batch
// by customerReference. Lets the admin portal show live PNC settlement status
// for processed rows without storing PNC state in the database.
router.get("/payroll/pay-run/pnc-status", requireAdmin, async (req, res): Promise<void> => {
  if (!isPncConfigured()) {
    res.status(503).json({ error: "Service Unavailable", message: "PNC API not configured.", configured: false });
    return;
  }

  const { customerReference } = req.query as Record<string, string | undefined>;
  if (!customerReference?.trim()) {
    res.status(400).json({ error: "Bad Request", message: "customerReference query param required" });
    return;
  }

  try {
    const status = await getPaymentStatusByCustomerRef(customerReference.trim());
    res.json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Bad Gateway", message: `PNC status check failed: ${msg}` });
  }
});

// =============================================================================
// PAYROLL BOARD — auto-flow from approved time entries.
//
// Compute-on-read: scans approved-but-unbilled time entries and groups them
// by (employee × site × ISO week). The "Process selected" handoff upserts
// payroll_entries with status='pending' (refusing to touch anything already
// processed/paid), then the existing Pay Run page takes over.
// =============================================================================

// Monday 00:00:00 UTC of the week containing d.
function mondayOfWeekUTC(d: Date): Date {
  const x = new Date(d);
  const day = x.getUTCDay();            // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // back up to Monday
  x.setUTCDate(x.getUTCDate() + diff);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

type BoardBucket = {
  employeeId: string;
  employeeName: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string; // YYYY-MM-DD (Monday)
  periodEnd: string;   // YYYY-MM-DD (Sunday)
  totalHours: number;
  hourlyRate: number;  // avg rate over the bucket
  grossPay: number;
  timeEntryIds: string[];
  // Lightweight per-entry detail so the admin UI can expand a bucket row and
  // verify the underlying approved shifts without a second round-trip.
  entries: Array<{ id: string; clockInTime: string; hoursWorked: number; rate: number; holiday: string | null; hasClockOut: boolean; scheduledEnd: string | null; lastEditedByEmail: string | null; lastEditedAt: string | null }>;
  existingPayrollEntryId: string | null;
  existingStatus: string | null; // pending | processed | paid | null (none)
  // Per-bucket warnings surfaced on the Payroll Board so admins notice
  // problems (zero rate, missing clock-out, missing bank info) BEFORE they
  // hand the batch off to Pay Run. Same wording as Pay Run preview warnings
  // where applicable, so the two pages stay consistent.
  warnings: string[];
};

/**
 * Build all approved time-entry buckets, with any existing payroll_entry
 * status attached. Buckets where the existing entry is already processed
 * or paid are still returned so the UI can show "Processed" status — the
 * caller filters them out for "Ready" lists.
 */
async function computeBoardBuckets(filters: {
  siteId?: string;
  from?: Date;
  to?: Date;
}): Promise<BoardBucket[]> {
  const conditions = [eq(timeEntriesTable.approvalStatus, "approved")];
  if (filters.from) conditions.push(gte(timeEntriesTable.clockInTime, filters.from));
  if (filters.to) conditions.push(lt(timeEntriesTable.clockInTime, filters.to));
  if (filters.siteId) {
    conditions.push(sql`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId}) = ${filters.siteId}`);
  }

  const rows = await db
    .select({
      timeEntryId: timeEntriesTable.id,
      employeeId: timeEntriesTable.employeeId,
      employeeFirst: usersTable.firstName,
      employeeLast: usersTable.lastName,
      clockInTime: timeEntriesTable.clockInTime,
      hoursWorked: timeEntriesTable.hoursWorked,
      siteId: sql<string | null>`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`,
      siteName: sitesTable.name,
      payRate: shiftsTable.payRate,
      employeeRate: employeesTable.hourlyRate,
      payRateOverride: timeEntriesTable.payRateOverride,
      // Bank/direct-deposit fields drive bucket-level warnings so the admin
      // can spot payable rows that will fail the Pay Run CSV export.
      bankAccountName: employeesTable.bankAccountName,
      bankAccountNumber: employeesTable.bankAccountNumber,
      bankBsb: employeesTable.bankBsb,
      directDepositConsent: employeesTable.directDepositConsent,
      // Null hoursWorked = missing clock-out (the column is only stamped on
      // clock-out). Track it explicitly so the warning is "missing clock-out"
      // rather than the more confusing "zero hours" when summed.
      hasClockOut: sql<boolean>`${timeEntriesTable.clockOutTime} IS NOT NULL`,
      // Scheduled shift end is surfaced so the Payroll Board can offer a
      // one-click "Set clock-out to scheduled end" fix on stuck entries.
      shiftEndTime: shiftsTable.endTime,
      // Admin-correction provenance — drives the "Edited" badge + change
      // history dialog on the Payroll Board's per-entry detail rows.
      lastEditedByEmail: timeEntriesTable.lastEditedByEmail,
      lastEditedAt: timeEntriesTable.lastEditedAt,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`)
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .leftJoin(employeesTable, eq(employeesTable.userId, timeEntriesTable.employeeId))
    .where(and(...conditions));

  // Aggregate per (employeeId, siteId, mondayISO).
  type Agg = {
    employeeId: string;
    employeeName: string | null;
    siteId: string | null;
    siteName: string | null;
    periodStart: string;
    periodEnd: string;
    hours: number;
    gross: number;
    timeEntryIds: string[];
    entries: Array<{ id: string; clockInTime: string; hoursWorked: number; rate: number; holiday: string | null; hasClockOut: boolean; scheduledEnd: string | null; lastEditedByEmail: string | null; lastEditedAt: string | null }>;
    zeroRateEntries: number;
    missingClockOutEntries: number;
    zeroHoursEntries: number;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    bankBsb: string | null;
    directDepositConsent: boolean | null;
  };
  const buckets = new Map<string, Agg>();
  for (const r of rows) {
    const monday = mondayOfWeekUTC(r.clockInTime);
    const periodStart = isoDate(monday);
    const periodEnd = isoDate(addDays(monday, 6));
    const siteKey = r.siteId ?? "__nosite__";
    const key = `${r.employeeId}|${siteKey}|${periodStart}`;
    const hours = parseFloat(String(r.hoursWorked || "0"));
    // Rate priority: per-entry admin override (set via the Payroll Board
    // "Apply pay rate" action) -> the assigned shift's payRate -> the
    // employee's default hourlyRate. The override exists so admins can
    // backfill historical zero-rate entries (no shift on file, or hired
    // before a rate was set) without rewriting shift/employee records.
    const rate = parseFloat(String(r.payRateOverride ?? r.payRate ?? r.employeeRate ?? "0"));
    // Federal-holiday premium (1.5×): entries clocked in on a US federal
    // holiday (in PAYROLL_TIMEZONE) earn time-and-a-half on the whole entry.
    // The effective rate flows into the bucket gross AND the per-entry detail
    // so the admin UI's "hours × rate = line gross" reconciles with the total.
    const holidayName = getFederalHolidayName(r.clockInTime);
    const effectiveRate = holidayName
      ? Math.round(rate * HOLIDAY_PAY_MULTIPLIER * 100) / 100
      : rate;
    let b = buckets.get(key);
    if (!b) {
      b = {
        employeeId: r.employeeId,
        employeeName: r.employeeFirst || r.employeeLast
          ? `${r.employeeFirst ?? ""} ${r.employeeLast ?? ""}`.trim()
          : null,
        siteId: r.siteId,
        siteName: r.siteName,
        periodStart,
        periodEnd,
        hours: 0,
        gross: 0,
        timeEntryIds: [],
        entries: [],
        zeroRateEntries: 0,
        missingClockOutEntries: 0,
        zeroHoursEntries: 0,
        bankAccountName: r.bankAccountName,
        bankAccountNumber: r.bankAccountNumber,
        bankBsb: r.bankBsb,
        directDepositConsent: r.directDepositConsent,
      };
      buckets.set(key, b);
    }
    b.hours += hours;
    b.gross += hours * effectiveRate;
    b.timeEntryIds.push(r.timeEntryId);
    if (rate <= 0) b.zeroRateEntries += 1;
    if (!r.hasClockOut) b.missingClockOutEntries += 1;
    // Zero-hour entries with a valid clock-out are a separate problem
    // (manual edit, same-second in/out, etc) — track them so the warning
    // can say "hours are 0" rather than misdiagnosing it as missing clock-out.
    else if (hours <= 0) b.zeroHoursEntries += 1;
    b.entries.push({
      id: r.timeEntryId,
      clockInTime: r.clockInTime.toISOString(),
      hoursWorked: Math.round(hours * 100) / 100,
      rate: Math.round(effectiveRate * 100) / 100,
      holiday: holidayName,
      hasClockOut: !!r.hasClockOut,
      scheduledEnd: r.shiftEndTime ? r.shiftEndTime.toISOString() : null,
      lastEditedByEmail: r.lastEditedByEmail ?? null,
      lastEditedAt: r.lastEditedAt ? r.lastEditedAt.toISOString() : null,
    });
  }

  // Look up any existing payroll_entries for these buckets. We match on
  // (employeeId, siteId, periodStart). Null siteId is a separate match
  // because the unique index allows NULL there.
  const employeeIds = Array.from(new Set(Array.from(buckets.values()).map((b) => b.employeeId)));
  const existing = employeeIds.length === 0
    ? []
    : await db
        .select({
          id: payrollEntriesTable.id,
          employeeId: payrollEntriesTable.employeeId,
          siteId: payrollEntriesTable.siteId,
          periodStart: payrollEntriesTable.periodStart,
          status: payrollEntriesTable.status,
        })
        .from(payrollEntriesTable)
        .where(inArray(payrollEntriesTable.employeeId, employeeIds));
  const existingMap = new Map<string, { id: string; status: string }>();
  for (const e of existing) {
    const key = `${e.employeeId}|${e.siteId ?? "__nosite__"}|${e.periodStart}`;
    existingMap.set(key, { id: e.id, status: e.status });
  }

  const out: BoardBucket[] = [];
  for (const [key, b] of buckets) {
    const ex = existingMap.get(key) ?? null;
    const warnings: string[] = [];
    if (b.zeroRateEntries > 0) {
      warnings.push(
        b.zeroRateEntries === b.entries.length
          ? "Pay rate is $0 — no shift rate or employee fallback rate on file"
          : `Pay rate is $0 on ${b.zeroRateEntries} of ${b.entries.length} entries`,
      );
    }
    if (b.missingClockOutEntries > 0) {
      warnings.push(
        b.missingClockOutEntries === 1
          ? "Missing clock-out on 1 time entry — expand the row and click Set clock-out to fix it"
          : `Missing clock-out on ${b.missingClockOutEntries} time entries — expand the row and click Set clock-out on each to fix them`,
      );
    }
    if (b.zeroHoursEntries > 0) {
      warnings.push(
        b.zeroHoursEntries === 1
          ? "Hours worked is 0 on 1 time entry"
          : `Hours worked is 0 on ${b.zeroHoursEntries} time entries`,
      );
    }
    // Bucket-level zero-hours guard: catches the case where summed hours
    // round to zero even though no individual entry tripped the per-entry
    // counters (e.g. only sub-minute entries). Avoids duplicate messaging
    // when a per-entry warning already fired.
    if (
      b.hours <= 0 &&
      b.zeroHoursEntries === 0 &&
      b.missingClockOutEntries === 0
    ) {
      warnings.push("Total hours worked is 0");
    }
    // Bank/direct-deposit checks mirror the Pay Run preview wording so the
    // two pages stay consistent. Skipped when the bucket is already paid —
    // the data is historical at that point.
    if (ex?.status !== "paid") {
      if (!b.bankAccountNumber) warnings.push("Missing bank account number");
      if (!b.bankBsb) warnings.push("Missing routing/sort code");
      if (!b.bankAccountName) warnings.push("Missing bank account name");
      if (b.directDepositConsent !== true) warnings.push("Direct-deposit consent not on file");
    }
    out.push({
      employeeId: b.employeeId,
      employeeName: b.employeeName,
      siteId: b.siteId,
      siteName: b.siteName,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      totalHours: Math.round(b.hours * 100) / 100,
      hourlyRate: b.hours > 0 ? Math.round((b.gross / b.hours) * 100) / 100 : 0,
      grossPay: Math.round(b.gross * 100) / 100,
      timeEntryIds: b.timeEntryIds,
      entries: b.entries.sort((a, c) => a.clockInTime.localeCompare(c.clockInTime)),
      existingPayrollEntryId: ex?.id ?? null,
      existingStatus: ex?.status ?? null,
      warnings,
    });
  }
  return out;
}

/**
 * GET /payroll/board?statusFilter=ready|partial|processed|all&siteId=…&from=…&to=…
 *
 * Returns approved time-entry buckets grouped by site → week.
 *
 * Bucket = one (employee × site × week). A bucket is "ready" when there is
 * no payroll_entry yet, or its existing payroll_entry is still `pending`.
 * A group is:
 *   - ready:     every bucket is ready
 *   - processed: every bucket is processed/paid
 *   - partial:   a mix (e.g. officer A is paid for the week; officer B's
 *                approval arrived later and is still ready)
 *
 * The default `statusFilter=ready` returns both `ready` AND `partial`
 * groups, but trims out the already-processed buckets in partial groups —
 * so newly-approved work in a partial week shows up as a ready delta
 * immediately, while paid officers are not re-listed. This is the
 * "Ready delta" semantic.
 *
 * NB: the granularity of the delta is per officer-week, not per individual
 * time entry. The DB enforces a unique payroll_entry per
 * (employeeId, siteId, periodStart), so once an officer's week has been
 * processed it cannot be re-opened without admin intervention on the
 * existing row in Pay Run. Newly approved time entries falling inside an
 * already-paid officer-week are intentionally NOT silently merged into a
 * second payroll_entry — they would create duplicate pay.
 */
router.get("/payroll/board", requireAdmin, async (req, res): Promise<void> => {
  const { statusFilter = "ready", siteId, from, to } = req.query as Record<string, string | undefined>;

  // Archived view: sourced directly from payroll_entries (status='archived'),
  // NOT from computeBoardBuckets — archived weeks must stay reviewable even if
  // their underlying time entries were later unapproved or deleted. The rows
  // carry the totals snapshotted at archive time.
  if (String(statusFilter) === "archived") {
    const conditions = [eq(payrollEntriesTable.status, "archived")];
    if (siteId) conditions.push(eq(payrollEntriesTable.siteId, siteId));
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) conditions.push(gte(payrollEntriesTable.periodStart, from));
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) conditions.push(lte(payrollEntriesTable.periodStart, to));
    const rows = await db
      .select({
        id: payrollEntriesTable.id,
        employeeId: payrollEntriesTable.employeeId,
        siteId: payrollEntriesTable.siteId,
        periodStart: payrollEntriesTable.periodStart,
        periodEnd: payrollEntriesTable.periodEnd,
        totalHours: payrollEntriesTable.totalHours,
        hourlyRate: payrollEntriesTable.hourlyRate,
        grossPay: payrollEntriesTable.grossPay,
        archivedAt: payrollEntriesTable.archivedAt,
        archivedBy: payrollEntriesTable.archivedBy,
        archiveReason: payrollEntriesTable.archiveReason,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        siteName: sitesTable.name,
      })
      .from(payrollEntriesTable)
      .leftJoin(usersTable, eq(usersTable.id, payrollEntriesTable.employeeId))
      .leftJoin(sitesTable, eq(sitesTable.id, payrollEntriesTable.siteId))
      .where(and(...conditions))
      .orderBy(desc(payrollEntriesTable.periodStart));

    const archiverIds = Array.from(new Set(rows.map((r) => r.archivedBy).filter((v): v is string => !!v)));
    const archivers = archiverIds.length === 0
      ? []
      : await db
          .select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable)
          .where(inArray(usersTable.id, archiverIds));
    const archiverEmail = new Map(archivers.map((a) => [a.id, a.email]));

    type ArchivedGroup = {
      siteId: string | null;
      siteName: string | null;
      periodStart: string;
      periodEnd: string;
      buckets: unknown[];
      status: "archived";
      totalHours: number;
      grossPay: number;
      officerCount: number;
    };
    const archGroups = new Map<string, ArchivedGroup>();
    for (const r of rows) {
      const key = `${r.siteId ?? "__nosite__"}|${r.periodStart}`;
      let g = archGroups.get(key);
      if (!g) {
        g = {
          siteId: r.siteId,
          siteName: r.siteName,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          buckets: [],
          status: "archived",
          totalHours: 0,
          grossPay: 0,
          officerCount: 0,
        };
        archGroups.set(key, g);
      }
      const hours = Number(r.totalHours) || 0;
      const gross = Number(r.grossPay) || 0;
      g.buckets.push({
        employeeId: r.employeeId,
        employeeName: [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
        siteId: r.siteId,
        siteName: r.siteName,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        totalHours: Math.round(hours * 100) / 100,
        hourlyRate: Math.round((Number(r.hourlyRate) || 0) * 100) / 100,
        grossPay: Math.round(gross * 100) / 100,
        timeEntryIds: [],
        entries: [],
        existingPayrollEntryId: r.id,
        existingStatus: "archived",
        warnings: [],
        archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
        archivedByEmail: r.archivedBy ? archiverEmail.get(r.archivedBy) ?? null : null,
        archiveReason: r.archiveReason ?? null,
      });
      g.totalHours += hours;
      g.grossPay += gross;
      g.officerCount += 1;
    }
    const archived = Array.from(archGroups.values()).map((g) => ({
      ...g,
      totalHours: Math.round(g.totalHours * 100) / 100,
      grossPay: Math.round(g.grossPay * 100) / 100,
    }));
    archived.sort((a, b) =>
      b.periodStart.localeCompare(a.periodStart) ||
      (a.siteName ?? "").localeCompare(b.siteName ?? ""),
    );
    res.json({ groups: archived });
    return;
  }

  const filters: { siteId?: string; from?: Date; to?: Date } = {};
  if (siteId) filters.siteId = siteId;
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) filters.from = d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) {
      // Admin "to" date is inclusive: a YYYY-MM-DD value parses to midnight
      // UTC of that day, but admins expect entries clocked-in during the
      // selected date to appear. Roll forward 24h so the underlying
      // `clockInTime < filters.to` comparison covers the whole day.
      filters.to = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  // Archived buckets leave the working board entirely — they are only
  // visible under statusFilter=archived (handled above).
  const buckets = (await computeBoardBuckets(filters)).filter(
    (b) => b.existingStatus !== "archived",
  );

  // Group by site+week to compute group status and totals.
  type Group = {
    siteId: string | null;
    siteName: string | null;
    periodStart: string;
    periodEnd: string;
    buckets: BoardBucket[];
    status: "ready" | "partial" | "processed";
    totalHours: number;
    grossPay: number;
    officerCount: number;
  };
  const groups = new Map<string, Group>();
  for (const b of buckets) {
    const key = `${b.siteId ?? "__nosite__"}|${b.periodStart}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        siteId: b.siteId,
        siteName: b.siteName,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        buckets: [],
        status: "ready",
        totalHours: 0,
        grossPay: 0,
        officerCount: 0,
      };
      groups.set(key, g);
    }
    g.buckets.push(b);
    g.totalHours += b.totalHours;
    g.grossPay += b.grossPay;
    g.officerCount += 1;
  }
  for (const g of groups.values()) {
    const processedCount = g.buckets.filter(
      (b) => b.existingStatus === "processed" || b.existingStatus === "paid",
    ).length;
    if (processedCount === 0) g.status = "ready";
    else if (processedCount === g.buckets.length) g.status = "processed";
    else g.status = "partial";
    g.totalHours = Math.round(g.totalHours * 100) / 100;
    g.grossPay = Math.round(g.grossPay * 100) / 100;
  }

  const wanted = String(statusFilter || "ready");
  let result = Array.from(groups.values());
  if (wanted === "ready") {
    // Ready delta: show ready + partial groups, but inside partial groups
    // hide the already-processed buckets so admins only see what's actionable.
    result = result
      .filter((g) => g.status === "ready" || g.status === "partial")
      .map((g) => {
        if (g.status !== "partial") return g;
        const readyBuckets = g.buckets.filter(
          (b) => b.existingStatus !== "processed" && b.existingStatus !== "paid",
        );
        const totalHours = Math.round(readyBuckets.reduce((a, b) => a + b.totalHours, 0) * 100) / 100;
        const grossPay = Math.round(readyBuckets.reduce((a, b) => a + b.grossPay, 0) * 100) / 100;
        return { ...g, buckets: readyBuckets, officerCount: readyBuckets.length, totalHours, grossPay };
      });
  } else if (wanted !== "all") {
    result = result.filter((g) => g.status === wanted);
  }
  result.sort((a, b) =>
    b.periodStart.localeCompare(a.periodStart) ||
    (a.siteName ?? "").localeCompare(b.siteName ?? ""),
  );

  res.json({ groups: result });
});

/**
 * POST /payroll/board/process
 *  body: { selections: [{employeeId, siteId|null, periodStart}], mode: "ach_csv"|"manual" }
 *
 * For each selection, recomputes hours/gross from current approved time
 * entries and UPSERTs a payroll_entry in `pending` state. Existing entries
 * that are already processed/paid are SKIPPED (never overwritten). Returns
 * the resulting payroll_entry ids so the caller can pre-select them on the
 * Pay Run page.
 */
const boardProcessSchema = z.object({
  mode: z.enum(["ach_csv", "manual"]).default("ach_csv"),
  selections: z.array(
    z.object({
      employeeId: z.string().uuid(),
      siteId: z.string().uuid().nullable(),
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    }),
  ).min(1, "selections[] required"),
});

router.post("/payroll/board/process", requireAdmin, async (req, res): Promise<void> => {
  const parsed = boardProcessSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message, issues: parsed.error.issues });
    return;
  }
  const { selections, mode: safeMode } = parsed.data;

  // Local audit helper so every exit path (success, 409 vanished, 409
  // all-skipped) writes a payroll.board_process row. The task requires
  // "every Process action" to be audited; bailing out early without
  // logging would silently drop those attempts.
  const writeAudit = async (statusCode: number, metadata: Record<string, unknown>) => {
    try {
      await db.insert(auditLogsTable).values({
        actorUserId: req.user?.userId ?? null,
        actorEmail: req.user?.email ?? null,
        actorRole: req.user?.role ?? null,
        action: "payroll.board_process",
        method: req.method,
        path: req.originalUrl,
        statusCode,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { mode: safeMode, selectionCount: selections.length, ...metadata },
      });
    } catch (err) {
      req.log?.error({ err }, "Failed to write payroll.board_process audit row");
    }
  };

  // Compute the full bucket set once and intersect with the caller's selections.
  const all = await computeBoardBuckets({});
  const wanted = new Set(
    selections.map((s) => `${s.employeeId}|${s.siteId ?? "__nosite__"}|${s.periodStart}`),
  );
  const matchingKeys = new Set(
    all.map((b) => `${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`),
  );
  const matching = all.filter((b) =>
    wanted.has(`${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`),
  );

  // If the user clicked Process but every selected bucket vanished between
  // load and submit (someone unapproved the time entries, or another admin
  // processed them first), surface that explicitly instead of silently
  // returning success with zero ids — otherwise Pay Run opens with nothing
  // selected and the admin has no idea why.
  const unmatched = selections.filter(
    (s) => !matchingKeys.has(`${s.employeeId}|${s.siteId ?? "__nosite__"}|${s.periodStart}`),
  );
  if (matching.length === 0) {
    await writeAudit(409, {
      matchedCount: 0,
      payrollEntryIds: [],
      skipped: [],
      unmatched,
      outcome: "vanished",
    });
    res.status(409).json({
      error: "Conflict",
      message: "None of the selected payroll buckets are still available — they may have been unapproved or processed by another admin. Please reload the Payroll Board.",
      unmatched,
    });
    return;
  }

  const createdIds: string[] = [];
  const skipped: Array<{
    employeeId: string;
    siteId: string | null;
    periodStart: string;
    reason: string;
    payrollEntryId?: string;
  }> = [];

  // Per-row idempotent upsert wrapped in a transaction with SELECT … FOR UPDATE.
  //
  // We do NOT rely on `ON CONFLICT (employeeId, siteId, periodStart)` because
  // Postgres treats NULL siteIds as distinct in a unique index — repeated
  // processing of a no-site bucket would silently insert duplicates and risk
  // double-pay. The explicit lookup-then-write path here handles both null and
  // non-null siteId identically, and never overwrites processed/paid rows.
  for (const b of matching) {
    if (b.existingStatus === "processed" || b.existingStatus === "paid" || b.existingStatus === "archived") {
      // Skipped buckets are NOT added to payrollEntryIds — Pay Run should
      // only preselect rows the admin can still act on. The existing id
      // is captured in `skipped` metadata for traceability. Archived
      // buckets must be unarchived before they can be processed.
      skipped.push({
        employeeId: b.employeeId,
        siteId: b.siteId,
        periodStart: b.periodStart,
        reason: b.existingStatus === "archived" ? "archived — unarchive it first" : `already ${b.existingStatus}`,
        payrollEntryId: b.existingPayrollEntryId ?? undefined,
      });
      continue;
    }
    const gross = b.grossPay;
    // 1099 contractors — no tax is withheld; net always equals gross.
    const tax = 0;
    const net = gross;

    const id = await db.transaction(async (tx) => {
      // Postgres treats NULLs in a unique index as distinct, so two concurrent
      // requests for the same no-site bucket would both see "no existing row"
      // and both insert. SELECT … FOR UPDATE can't help when there's no row
      // to lock yet. Serialize at the bucket key with a transactional advisory
      // lock so the lookup→insert is atomic across connections.
      const lockKey = `payroll-board:${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const siteCond = b.siteId === null
        ? isNull(payrollEntriesTable.siteId)
        : eq(payrollEntriesTable.siteId, b.siteId);
      const existing = await tx
        .select({ id: payrollEntriesTable.id, status: payrollEntriesTable.status })
        .from(payrollEntriesTable)
        .where(and(
          eq(payrollEntriesTable.employeeId, b.employeeId),
          siteCond,
          eq(payrollEntriesTable.periodStart, b.periodStart),
        ))
        .for("update");

      if (existing.length > 0) {
        const row = existing[0]!;
        // Re-check inside the lock — another worker may have processed or
        // archived it.
        if (row.status === "processed" || row.status === "paid" || row.status === "archived") {
          skipped.push({
            employeeId: b.employeeId,
            siteId: b.siteId,
            periodStart: b.periodStart,
            reason: row.status === "archived" ? "archived — unarchive it first" : `already ${row.status}`,
            payrollEntryId: row.id,
          });
          return null;
        }
        await tx
          .update(payrollEntriesTable)
          .set({
            totalHours: String(b.totalHours),
            hourlyRate: String(b.hourlyRate),
            grossPay: String(gross),
            tax: String(tax),
            netPay: String(net),
            updatedAt: new Date(),
          })
          .where(eq(payrollEntriesTable.id, row.id));
        return row.id;
      }

      const [inserted] = await tx
        .insert(payrollEntriesTable)
        .values({
          employeeId: b.employeeId,
          siteId: b.siteId,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          totalHours: String(b.totalHours),
          hourlyRate: String(b.hourlyRate),
          grossPay: String(gross),
          tax: String(tax),
          netPay: String(net),
          status: "pending",
        })
        .returning({ id: payrollEntriesTable.id });
      return inserted?.id ?? null;
    });
    if (id) createdIds.push(id);
  }

  const payrollEntryIds = Array.from(new Set(createdIds));

  // If every matched bucket got skipped (all processed/paid by the time we
  // locked them), `payrollEntryIds` is empty. Returning 200 here would send
  // the admin to Pay Run with no preselection and no explanation — surface
  // it as a conflict instead. Still audit the attempt.
  if (payrollEntryIds.length === 0) {
    await writeAudit(409, {
      matchedCount: matching.length,
      payrollEntryIds: [],
      skipped,
      unmatched,
      outcome: "all_skipped",
      buckets: matching.map((b) => ({
        employeeId: b.employeeId,
        siteId: b.siteId,
        periodStart: b.periodStart,
        timeEntryIds: b.timeEntryIds,
      })),
    });
    res.status(409).json({
      error: "Conflict",
      message: "All selected payroll buckets have already been processed or paid. Reload the Payroll Board to see the latest state.",
      skipped,
      unmatched,
    });
    return;
  }

  // Explicit audit row. The generic /payroll prefix would also tag this as
  // "payroll.update" with the request body, but we want a first-class action
  // type AND the resulting payroll_entry ids in the audit metadata so ops
  // can answer "which Pay Run batch came from which Board click?".
  await writeAudit(200, {
    matchedCount: matching.length,
    payrollEntryIds,
    skipped,
    unmatched,
    outcome: "ok",
    buckets: matching.map((b) => ({
      employeeId: b.employeeId,
      siteId: b.siteId,
      periodStart: b.periodStart,
      timeEntryIds: b.timeEntryIds,
    })),
  });

  res.status(200).json({
    payrollEntryIds,
    mode: safeMode,
    processedCount: payrollEntryIds.length,
    skipped,
    unmatched,
  });
});

/**
 * POST /payroll/board/archive
 *   body: { selections: [{employeeId, siteId|null, periodStart}], reason? }
 *
 * Admin-only. Archives officer-week buckets: upserts the bucket's
 * payroll_entry with status='archived' plus a snapshot of the current
 * totals, so the bucket leaves the working Payroll Board but remains
 * reviewable (and restorable) under the board's Archived view.
 *
 * Guardrails:
 *   - processed/paid rows are NEVER archived — those are financial records
 *     that have already been exported/paid. Skipped with a reason.
 *   - already-archived buckets are skipped (idempotent).
 *   - archived rows are excluded from the working board, board process,
 *     apply-rate, Pay Run export/mark-paid (status-gated), and officer
 *     paystubs.
 *   - Audit-logged as payroll.board_archive on every exit path.
 */
const boardArchiveSchema = z.object({
  reason: z.string().trim().max(500, "reason must be 500 characters or fewer").optional(),
  selections: z.array(
    z.object({
      employeeId: z.string().uuid(),
      siteId: z.string().uuid().nullable(),
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    }),
  ).min(1, "selections[] required"),
});

router.post("/payroll/board/archive", requireAdmin, async (req, res): Promise<void> => {
  const parsed = boardArchiveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message, issues: parsed.error.issues });
    return;
  }
  const { selections, reason } = parsed.data;

  const writeAudit = async (statusCode: number, metadata: Record<string, unknown>) => {
    try {
      await db.insert(auditLogsTable).values({
        actorUserId: req.user?.userId ?? null,
        actorEmail: req.user?.email ?? null,
        actorRole: req.user?.role ?? null,
        action: "payroll.board_archive",
        method: req.method,
        path: req.originalUrl,
        statusCode,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { reason: reason ?? null, selectionCount: selections.length, ...metadata },
      });
    } catch (err) {
      req.log?.error({ err }, "Failed to write payroll.board_archive audit row");
    }
  };

  const all = await computeBoardBuckets({});
  const wanted = new Set(
    selections.map((s) => `${s.employeeId}|${s.siteId ?? "__nosite__"}|${s.periodStart}`),
  );
  const matchingKeys = new Set(
    all.map((b) => `${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`),
  );
  const matching = all.filter((b) =>
    wanted.has(`${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`),
  );
  const unmatched = selections.filter(
    (s) => !matchingKeys.has(`${s.employeeId}|${s.siteId ?? "__nosite__"}|${s.periodStart}`),
  );

  if (matching.length === 0) {
    await writeAudit(409, { matchedCount: 0, payrollEntryIds: [], skipped: [], unmatched, outcome: "vanished" });
    res.status(409).json({
      error: "Conflict",
      message: "None of the selected payroll buckets are still on the board — they may have been unapproved or changed by another admin. Please reload the Payroll Board.",
      unmatched,
    });
    return;
  }

  const archivedIds: string[] = [];
  const skipped: Array<{
    employeeId: string;
    siteId: string | null;
    periodStart: string;
    reason: string;
    payrollEntryId?: string;
  }> = [];

  for (const b of matching) {
    // Pre-lock fast path: never touch financial records; re-archiving is a no-op.
    if (b.existingStatus === "processed" || b.existingStatus === "paid" || b.existingStatus === "archived") {
      skipped.push({
        employeeId: b.employeeId,
        siteId: b.siteId,
        periodStart: b.periodStart,
        reason: `already ${b.existingStatus}`,
        payrollEntryId: b.existingPayrollEntryId ?? undefined,
      });
      continue;
    }
    const gross = b.grossPay;
    // 1099 contractors — no tax is withheld; net always equals gross.
    const tax = 0;
    const net = gross;

    const id = await db.transaction(async (tx) => {
      // Same advisory-lock discipline as board process: NULL siteIds are
      // distinct in the unique index, so serialize the lookup→write at the
      // bucket key to avoid duplicate rows under concurrency.
      const lockKey = `payroll-board:${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const siteCond = b.siteId === null
        ? isNull(payrollEntriesTable.siteId)
        : eq(payrollEntriesTable.siteId, b.siteId);
      const existing = await tx
        .select({ id: payrollEntriesTable.id, status: payrollEntriesTable.status })
        .from(payrollEntriesTable)
        .where(and(
          eq(payrollEntriesTable.employeeId, b.employeeId),
          siteCond,
          eq(payrollEntriesTable.periodStart, b.periodStart),
        ))
        .for("update");

      if (existing.length > 0) {
        const row = existing[0]!;
        // Re-check inside the lock — another admin may have processed,
        // paid, or archived it since we computed the buckets.
        if (row.status === "processed" || row.status === "paid" || row.status === "archived") {
          skipped.push({
            employeeId: b.employeeId,
            siteId: b.siteId,
            periodStart: b.periodStart,
            reason: `already ${row.status}`,
            payrollEntryId: row.id,
          });
          return null;
        }
        await tx
          .update(payrollEntriesTable)
          .set({
            totalHours: String(b.totalHours),
            hourlyRate: String(b.hourlyRate),
            grossPay: String(gross),
            tax: String(tax),
            netPay: String(net),
            status: "archived",
            archivedAt: new Date(),
            archivedBy: req.user?.userId ?? null,
            archiveReason: reason ?? null,
            updatedAt: new Date(),
          })
          .where(eq(payrollEntriesTable.id, row.id));
        return row.id;
      }

      const [inserted] = await tx
        .insert(payrollEntriesTable)
        .values({
          employeeId: b.employeeId,
          siteId: b.siteId,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          totalHours: String(b.totalHours),
          hourlyRate: String(b.hourlyRate),
          grossPay: String(gross),
          tax: String(tax),
          netPay: String(net),
          status: "archived",
          archivedAt: new Date(),
          archivedBy: req.user?.userId ?? null,
          archiveReason: reason ?? null,
        })
        .returning({ id: payrollEntriesTable.id });
      return inserted?.id ?? null;
    });
    if (id) archivedIds.push(id);
  }

  const payrollEntryIds = Array.from(new Set(archivedIds));

  if (payrollEntryIds.length === 0) {
    await writeAudit(409, {
      matchedCount: matching.length,
      payrollEntryIds: [],
      skipped,
      unmatched,
      outcome: "all_skipped",
    });
    res.status(409).json({
      error: "Conflict",
      message: "None of the selected buckets could be archived — they are already processed, paid, or archived. Reload the Payroll Board to see the latest state.",
      skipped,
      unmatched,
    });
    return;
  }

  await writeAudit(200, {
    matchedCount: matching.length,
    payrollEntryIds,
    skipped,
    unmatched,
    outcome: "ok",
    buckets: matching.map((b) => ({
      employeeId: b.employeeId,
      siteId: b.siteId,
      periodStart: b.periodStart,
      timeEntryIds: b.timeEntryIds,
    })),
  });

  res.status(200).json({
    payrollEntryIds,
    archivedCount: payrollEntryIds.length,
    skipped,
    unmatched,
  });
});

/**
 * POST /payroll/board/unarchive
 *   body: { ids: string[] }  — payroll_entry ids from the Archived view
 *
 * Admin-only. Restores archived rows to status='pending' (clearing the
 * archive trail), which puts the officer-week back on the working board.
 * Only rows currently in status='archived' are touched — a row that was
 * meanwhile processed/paid through some other path is left alone.
 * Audit-logged as payroll.board_unarchive.
 */
const boardUnarchiveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, "ids[] required"),
});

router.post("/payroll/board/unarchive", requireAdmin, async (req, res): Promise<void> => {
  const parsed = boardUnarchiveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message, issues: parsed.error.issues });
    return;
  }
  const { ids } = parsed.data;

  const restored = await db
    .update(payrollEntriesTable)
    .set({
      status: "pending",
      archivedAt: null,
      archivedBy: null,
      archiveReason: null,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(payrollEntriesTable.id, ids),
      eq(payrollEntriesTable.status, "archived"),
    ))
    .returning({ id: payrollEntriesTable.id });

  const payrollEntryIds = restored.map((r) => r.id);

  try {
    await db.insert(auditLogsTable).values({
      actorUserId: req.user?.userId ?? null,
      actorEmail: req.user?.email ?? null,
      actorRole: req.user?.role ?? null,
      action: "payroll.board_unarchive",
      method: req.method,
      path: req.originalUrl,
      statusCode: payrollEntryIds.length === 0 ? 409 : 200,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: { requestedIds: ids, payrollEntryIds, restoredCount: payrollEntryIds.length },
    });
  } catch (err) {
    req.log?.error({ err }, "Failed to write payroll.board_unarchive audit row");
  }

  if (payrollEntryIds.length === 0) {
    res.status(409).json({
      error: "Conflict",
      message: "None of the selected rows are archived anymore — reload the board to see the latest state.",
    });
    return;
  }

  res.status(200).json({ payrollEntryIds, restoredCount: payrollEntryIds.length });
});

/**
 * POST /payroll/board/apply-rate
 *   body: { timeEntryIds: string[], rate: number, onlyZeroRate?: boolean }
 *
 * Admin-only. Sets `time_entries.pay_rate_override = rate` on each given
 * entry, which `computeBoardBuckets` reads as the highest-priority pay
 * rate. Lets admins backfill rates on entries that had no shift.payRate
 * and no employee.hourlyRate to fall back to (a $0 bucket warning).
 *
 * Guardrails:
 *   - rate must be > 0 and <= $1000/hr (sanity ceiling, not policy).
 *   - we refuse to touch entries that already belong to a processed/paid
 *     payroll_entry — those numbers have already been exported to the
 *     bank and shouldn't change.
 *   - onlyZeroRate=true (default) skips entries whose current effective
 *     rate is already > 0, so admins can safely click "Apply" on a wide
 *     selection without overwriting valid rates. Pass `false` to force
 *     overwrite (e.g. a true rate correction).
 *   - Audit-logged with the resolved counts.
 */
const applyRateSchema = z.object({
  timeEntryIds: z.array(z.string().uuid()).min(1, "timeEntryIds[] required"),
  rate: z.number().positive("rate must be > 0").max(1000, "rate must be <= 1000"),
  onlyZeroRate: z.boolean().optional().default(true),
});

router.post("/payroll/board/apply-rate", requireAdmin, async (req, res): Promise<void> => {
  const parsed = applyRateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message, issues: parsed.error.issues });
    return;
  }
  const { timeEntryIds, rate, onlyZeroRate } = parsed.data;

  // Pull the candidates with their current effective rate so we can apply
  // the onlyZeroRate filter, skip already-paid weeks, and produce an
  // accurate audit summary.
  const rows = await db
    .select({
      id: timeEntriesTable.id,
      employeeId: timeEntriesTable.employeeId,
      clockInTime: timeEntriesTable.clockInTime,
      siteId: sql<string | null>`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`,
      shiftRate: shiftsTable.payRate,
      employeeRate: employeesTable.hourlyRate,
      override: timeEntriesTable.payRateOverride,
      approvalStatus: timeEntriesTable.approvalStatus,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(employeesTable, eq(employeesTable.userId, timeEntriesTable.employeeId))
    .where(inArray(timeEntriesTable.id, timeEntryIds));

  // Find time entries whose bucket is already processed/paid -- they get
  // skipped. Match on (employeeId, siteId, mondayOfClockIn).
  const peKeys = rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    siteId: r.siteId,
    periodStart: isoDate(mondayOfWeekUTC(r.clockInTime)),
  }));
  const employeeIds = Array.from(new Set(peKeys.map((p) => p.employeeId)));
  const existing = employeeIds.length === 0 ? [] : await db
    .select({
      employeeId: payrollEntriesTable.employeeId,
      siteId: payrollEntriesTable.siteId,
      periodStart: payrollEntriesTable.periodStart,
      status: payrollEntriesTable.status,
    })
    .from(payrollEntriesTable)
    .where(inArray(payrollEntriesTable.employeeId, employeeIds));
  const peStatusByKey = new Map<string, string>();
  for (const pe of existing) {
    const k = `${pe.employeeId}|${pe.siteId ?? "__nosite__"}|${pe.periodStart}`;
    peStatusByKey.set(k, pe.status);
  }

  const toUpdate: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const r of rows) {
    const k = `${r.employeeId}|${r.siteId ?? "__nosite__"}|${isoDate(mondayOfWeekUTC(r.clockInTime))}`;
    const peStatus = peStatusByKey.get(k);
    if (peStatus === "processed" || peStatus === "paid" || peStatus === "archived") {
      skipped.push({ id: r.id, reason: peStatus === "archived" ? "bucket is archived" : `bucket already ${peStatus}` });
      continue;
    }
    if (onlyZeroRate) {
      const effective = parseFloat(String(r.override ?? r.shiftRate ?? r.employeeRate ?? "0"));
      if (effective > 0) {
        skipped.push({ id: r.id, reason: "already has a non-zero rate" });
        continue;
      }
    }
    toUpdate.push(r.id);
  }
  const missing = timeEntryIds.filter((id) => !rows.some((r) => r.id === id));
  for (const id of missing) skipped.push({ id, reason: "time entry not found" });

  if (toUpdate.length > 0) {
    await db
      .update(timeEntriesTable)
      .set({ payRateOverride: String(rate), updatedAt: new Date() })
      .where(inArray(timeEntriesTable.id, toUpdate));
  }

  // First-class audit row -- separate action so ops can answer
  // "which rate did admin X apply to which entries on which day?".
  try {
    await db.insert(auditLogsTable).values({
      actorUserId: req.user?.userId ?? null,
      actorEmail: req.user?.email ?? null,
      actorRole: req.user?.role ?? null,
      action: "payroll.board_apply_rate",
      method: req.method,
      path: req.originalUrl,
      statusCode: 200,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: {
        rate,
        onlyZeroRate,
        requestedCount: timeEntryIds.length,
        updatedCount: toUpdate.length,
        skippedCount: skipped.length,
        // Cap per-row arrays so a 1000-entry batch doesn't bloat the
        // audit JSONB. Counts above are authoritative; samples are for
        // spot-debugging only.
        updatedIdsSample: toUpdate.slice(0, 50),
        skippedSample: skipped.slice(0, 50),
        samplesTruncated: toUpdate.length > 50 || skipped.length > 50,
      },
    });
  } catch (err) {
    req.log?.error({ err }, "Failed to write payroll.board_apply_rate audit row");
  }

  res.status(200).json({
    rate,
    updatedCount: toUpdate.length,
    skippedCount: skipped.length,
    skipped,
  });
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
