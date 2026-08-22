import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db, subcontractorInvoicesTable, subcontractorsTable } from "@workspace/db";
import { requireAdmin, requireCompanyOwner } from "../middlewares/auth";
import { idempotentWrite } from "../lib/idempotency";

const router: IRouter = Router();

// =============================================================================
// SUBCONTRACTOR PAY RUN — accounts-payable execution for vendor invoices.
//
// Mirrors the officer Pay Run (routes/payroll.ts) but pays subcontractors
// against their approved invoices:
//   1. POST /subcontractor-pay-run/preview     — detail + bank info + warnings
//   2. POST /subcontractor-pay-run/export-csv   — download ACH CSV, mark processed
//   3. POST /subcontractor-pay-run/mark-paid    — confirm bank settled, mark paid
//   4. POST /subcontractor-pay-run/stripe       — scaffolded (501 unless enabled)
//
// Only invoices in status "approved" are payable. A draft/pending invoice must
// be approved first (via the generic invoices grid) before it can be paid.
// =============================================================================

type PayRunRow = {
  id: string;
  subcontractorId: string;
  companyName: string | null;
  invoiceNumber: string;
  description: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: string;
  status: string;
  paidAt: Date | null;
  paidMethod: string | null;
  paymentReference: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
  directDepositConsent: boolean | null;
  warnings: string[];
};

async function loadPayRunRows(ids: string[]): Promise<PayRunRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: subcontractorInvoicesTable.id,
      subcontractorId: subcontractorInvoicesTable.subcontractorId,
      companyName: subcontractorsTable.companyName,
      invoiceNumber: subcontractorInvoicesTable.invoiceNumber,
      description: subcontractorInvoicesTable.description,
      issueDate: subcontractorInvoicesTable.issueDate,
      dueDate: subcontractorInvoicesTable.dueDate,
      totalAmount: subcontractorInvoicesTable.totalAmount,
      status: subcontractorInvoicesTable.status,
      paidAt: subcontractorInvoicesTable.paidAt,
      paidMethod: subcontractorInvoicesTable.paidMethod,
      paymentReference: subcontractorInvoicesTable.paymentReference,
      bankAccountName: subcontractorsTable.bankAccountName,
      bankAccountNumber: subcontractorsTable.bankAccountNumber,
      bankRoutingNumber: subcontractorsTable.bankRoutingNumber,
      directDepositConsent: subcontractorsTable.directDepositConsent,
    })
    .from(subcontractorInvoicesTable)
    .leftJoin(subcontractorsTable, eq(subcontractorInvoicesTable.subcontractorId, subcontractorsTable.id))
    .where(inArray(subcontractorInvoicesTable.id, ids));

  return rows.map((r) => {
    const warnings: string[] = [];
    if (r.status !== "approved" && r.status !== "processed" && r.status !== "paid") {
      warnings.push(`Invoice not approved (status: ${r.status})`);
    }
    if (!r.bankAccountNumber) warnings.push("Missing bank account number");
    if (!r.bankRoutingNumber) warnings.push("Missing routing number");
    if (!r.bankAccountName) warnings.push("Missing bank account name");
    if (r.directDepositConsent !== true) warnings.push("Direct-deposit consent not on file");
    if (Number(r.totalAmount) <= 0) warnings.push("Invoice total is zero or negative");
    return { ...r, warnings };
  });
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Neutralise spreadsheet formula-injection prefixes (=, +, -, @, |, tab, CR).
  if (/^[=+\-@|]/.test(s) || s.startsWith("\t") || s.startsWith("\r")) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.post("/subcontractor-pay-run/preview", requireCompanyOwner, async (req, res): Promise<void> => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const rows = await loadPayRunRows(ids);
  const totals = rows.reduce((acc, r) => {
    acc.total += Number(r.totalAmount);
    return acc;
  }, { total: 0 });
  const round2 = (n: number) => Math.round(n * 100) / 100;
  res.json({
    rows,
    counts: {
      total: rows.length,
      // Only "approved" rows are actually exportable; preview reflects that so
      // the count matches what Export will pay.
      payable: rows.filter((r) => r.status === "approved" && r.warnings.length === 0).length,
      withWarnings: rows.filter((r) => r.warnings.length > 0).length,
      alreadyPaid: rows.filter((r) => r.status === "paid").length,
    },
    totals: { total: round2(totals.total) },
  });
});

router.post("/subcontractor-pay-run/export-csv", requireCompanyOwner, async (req, res): Promise<void> => {
  const { ids, batchReference } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const rows = await loadPayRunRows(ids);
  // ONLY "approved" invoices are exportable. A processed/paid row must never
  // be re-exported (that would generate a duplicate outbound payment file),
  // and pending/rejected rows are not yet payable.
  const eligible = rows.filter((r) => r.status === "approved" && r.warnings.length === 0);
  if (eligible.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No invoices are payable (must be approved, with bank info, and not already processed/paid)." });
    return;
  }

  const batchId = (batchReference && String(batchReference).trim()) || `APBATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  // Concurrency-safe claim: atomically transition approved → processed and let
  // RETURNING tell us which rows THIS request actually won. The CSV is built
  // only from claimed rows, so two concurrent exports can never both emit a
  // payment line for the same invoice (the loser's claim returns nothing).
  const claimed = await db
    .update(subcontractorInvoicesTable)
    .set({
      status: "processed",
      paidMethod: "ach_csv",
      paymentReference: batchId,
      paidBy: req.user!.userId,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(subcontractorInvoicesTable.id, eligible.map((r) => r.id)),
      eq(subcontractorInvoicesTable.status, "approved"),
    ))
    .returning({ id: subcontractorInvoicesTable.id });
  const claimedIds = new Set(claimed.map((c) => c.id));
  const payable = eligible.filter((r) => claimedIds.has(r.id));
  if (payable.length === 0) {
    res.status(409).json({ error: "Conflict", message: "Selected invoices were already processed by another export." });
    return;
  }

  // Standard ACH-style CSV — same column shape as the officer Pay Run export.
  const header = [
    "Subcontractor", "Account Name", "Routing Number", "Account Number",
    "Amount (USD)", "Invoice #", "Issue Date", "Due Date", "Reference", "Memo",
  ].join(",");
  const lines = payable.map((r) =>
    [
      csvEscape(r.companyName),
      csvEscape(r.bankAccountName),
      csvEscape(r.bankRoutingNumber),
      csvEscape(r.bankAccountNumber),
      csvEscape(Number(r.totalAmount).toFixed(2)),
      csvEscape(r.invoiceNumber),
      csvEscape(r.issueDate),
      csvEscape(r.dueDate),
      csvEscape(`${batchId}-${r.id.slice(0, 8)}`),
      csvEscape(`WCSG subcontractor invoice ${r.invoiceNumber}`),
    ].join(","),
  );
  const csv = [header, ...lines].join("\r\n") + "\r\n";

  const filename = `wcsg-subcontractor-${batchId}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Pay-Run-Batch", batchId);
  res.setHeader("X-Pay-Run-Count", String(payable.length));
  res.setHeader("X-Pay-Run-Skipped", String(rows.length - payable.length));
  res.status(200).send(csv);
});

// Replay protection: a caller may supply an `idempotencyKey` (body field or
// `idempotency-key` header). A duplicate submission under the same key is
// answered from the first attempt's response instead of re-running the
// UPDATE — see lib/idempotency.ts. Optional and additive: callers that don't
// send a key see no behaviour change.
router.post("/subcontractor-pay-run/mark-paid", requireAdmin, idempotentWrite, async (req, res): Promise<void> => {
  const { ids, paymentReference, method } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" });
    return;
  }
  const safeMethod = ["manual", "ach_csv", "stripe"].includes(method) ? method : "manual";
  // Only invoices that have reached a payable state can be confirmed paid:
  //   - "processed": the normal path (ACH CSV exported, awaiting bank confirm)
  //   - "approved":  direct manual payment without exporting a CSV
  // pending / rejected / failed / paid are intentionally NOT mark-payable.
  const updated = await db
    .update(subcontractorInvoicesTable)
    .set({
      status: "paid",
      paidAt: new Date(),
      paidBy: req.user!.userId,
      paidMethod: safeMethod,
      paymentReference: paymentReference ? String(paymentReference) : sql`coalesce(${subcontractorInvoicesTable.paymentReference}, NULL)`,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(subcontractorInvoicesTable.id, ids),
      inArray(subcontractorInvoicesTable.status, ["approved", "processed"]),
    ))
    .returning({ id: subcontractorInvoicesTable.id });
  res.json({ marked: updated.length, skipped: ids.length - updated.length, ids: updated.map((r) => r.id) });
});

router.post("/subcontractor-pay-run/stripe", requireAdmin, async (req, res): Promise<void> => {
  if (process.env.STRIPE_CONNECT_ENABLED !== "true") {
    res.status(501).json({
      error: "Not Implemented",
      message: "Stripe Connect payments are scaffolded but disabled. Set STRIPE_CONNECT_ENABLED=true and provide STRIPE_SECRET_KEY + each subcontractor's stripeAccountId to enable.",
      configured: false,
    });
    return;
  }
  res.status(501).json({ error: "Not Implemented", message: "Stripe Connect transfer logic not wired yet — set up connected accounts first." });
});

export default router;
