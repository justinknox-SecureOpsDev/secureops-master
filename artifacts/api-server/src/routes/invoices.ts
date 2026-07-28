import { Router, type IRouter } from "express";
import { eq, and, ilike, ne, lte, gte } from "drizzle-orm";
import { db, invoicesTable, sitesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import {
  upsertWeeklyInvoice,
  upsertCustomPeriodInvoice,
  collectInvoicePeriodEntries,
  buildLineItemsFromEntries,
  invoicePeriodWindow,
} from "../lib/invoiceSync";
import { buildInvoicePdf } from "../lib/invoicePdf";
import { sendEmailDetailed } from "../lib/email";
import { brand } from "../lib/brandConfig";
import { requireFeature } from "../lib/features";
import { isProcessingFeeEnabled, getProcessingFeeRate } from "../lib/processingFeeConfig";
import { getFeeMigrationPendingCount } from "../lib/invoiceProcessingFeeBackfill";

const router: IRouter = Router();
router.use("/invoices", requireFeature("invoicing"));

// Re-sync line items for an auto-synced invoice if they were stored before the
// `level` field was introduced (old JSONB entries have no `level` key at all,
// as opposed to new entries that may legitimately carry `level: null`).
async function refreshLineItemsIfStale(
  invoiceId: string,
  siteId: string | null,
  autoSynced: boolean,
  lineItems: InvoiceLineItem[] | null,
  periodStart: string,
): Promise<InvoiceLineItem[] | null> {
  if (
    !autoSynced ||
    !siteId ||
    !Array.isArray(lineItems) ||
    lineItems.length === 0 ||
    lineItems.every((item) => "level" in item)
  ) {
    return lineItems;
  }
  // At least one line item is missing the level key — re-sync to pick it up.
  await upsertWeeklyInvoice(siteId, periodStart);
  const [refreshed] = await db
    .select({ lineItems: invoicesTable.lineItems })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId));
  return (refreshed?.lineItems as InvoiceLineItem[] | null) ?? lineItems;
}

function generateInvoiceNumber(): string {
  const now = new Date();
  const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const suffix = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
  return `${prefix}-${suffix}`;
}

async function calcTotals(
  lineItems: Array<{ description: string; hours?: number; rate?: number; amount: number }>,
  siteId?: string | null,
) {
  const subtotal = Math.round(
    lineItems.reduce((s, item) => {
      const amount = item.amount ?? (item.hours && item.rate ? item.hours * item.rate : 0);
      return s + amount;
    }, 0) * 100,
  ) / 100;

  // Resolve per-site settings when a siteId is provided so manually
  // created / edited invoices auto-apply the same fee as auto-synced ones.
  let siteFeeEnabled = false;
  let siteFeeRate = 0;
  if (siteId) {
    const [site] = await db
      .select({ salesTaxEnabled: sitesTable.salesTaxEnabled, salesTaxRate: sitesTable.salesTaxRate })
      .from(sitesTable)
      .where(eq(sitesTable.id, siteId));
    if (site?.salesTaxEnabled) {
      siteFeeEnabled = true;
      siteFeeRate = parseFloat(String(site.salesTaxRate ?? "8.25"));
    }
  }

  // Unified fee: platform master switch AND per-site salesTaxEnabled.
  const feeEnabled = isProcessingFeeEnabled() && siteFeeEnabled;
  const feeRate = feeEnabled ? siteFeeRate : 0;
  const feeAmount = feeEnabled ? Math.round(subtotal * feeRate / 100 * 100) / 100 : 0;
  const total = Math.round((subtotal + feeAmount) * 100) / 100;
  return {
    subtotal,
    total,
    processingFeeRate: feeEnabled ? feeRate : null,
    processingFeeAmount: feeEnabled ? feeAmount : null,
  };
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/admin/invoices/fee-migration-status
 *
 * Returns the number of draft invoices that still carry tax_amount > 0 with
 * processing_fee_amount IS NULL — i.e. rows that have not yet been touched by
 * the boot backfill. Operators can call this after a deploy to confirm the
 * migration ran cleanly:  { "pendingCount": 0 } means all rows are migrated.
 *
 * Read-only — no data is modified.
 */
router.get("/invoices/fee-migration-status", requireAdmin, async (_req, res): Promise<void> => {
  const pendingCount = await getFeeMigrationPendingCount();
  res.json({ pendingCount });
});

router.get("/invoices", requireAdmin, async (req, res): Promise<void> => {
  const { status, clientName, siteId, clientId, overlapStart, overlapEnd } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (status) conditions.push(eq(invoicesTable.status, status));
  if (clientName) conditions.push(ilike(invoicesTable.clientName, `%${clientName}%`));
  if (siteId) conditions.push(eq(invoicesTable.siteId, siteId));
  if (clientId) conditions.push(eq(invoicesTable.clientId, clientId));

  // Double-billing pre-check: filter to non-void invoices whose period
  // overlaps [overlapStart, overlapEnd] (inclusive dates). Both params must
  // be provided together and be valid ISO dates.
  if (overlapStart || overlapEnd) {
    const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!overlapStart || !overlapEnd || !isoDateRe.test(overlapStart) || !isoDateRe.test(overlapEnd)) {
      res.status(400).json({ error: "Bad Request", message: "overlapStart and overlapEnd must both be provided as YYYY-MM-DD" });
      return;
    }
    conditions.push(ne(invoicesTable.status, "void"));
    conditions.push(lte(invoicesTable.periodStart, overlapEnd));
    conditions.push(gte(invoicesTable.periodEnd, overlapStart));
  }

  const rows = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      clientId: invoicesTable.clientId,
      siteId: invoicesTable.siteId,
      siteName: sitesTable.name,
      periodStart: invoicesTable.periodStart,
      periodEnd: invoicesTable.periodEnd,
      clientName: invoicesTable.clientName,
      clientEmail: invoicesTable.clientEmail,
      clientAddress: invoicesTable.clientAddress,
      lineItems: invoicesTable.lineItems,
      subtotal: invoicesTable.subtotal,
      taxAmount: invoicesTable.taxAmount,
      totalAmount: invoicesTable.totalAmount,
      status: invoicesTable.status,
      dueDate: invoicesTable.dueDate,
      paidAt: invoicesTable.paidAt,
      notes: invoicesTable.notes,
      autoSynced: invoicesTable.autoSynced,
      lockedAt: invoicesTable.lockedAt,
      processingFeeRate: invoicesTable.processingFeeRate,
      processingFeeAmount: invoicesTable.processingFeeAmount,
      createdAt: invoicesTable.createdAt,
    })
    .from(invoicesTable)
    .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows);
});

router.post("/invoices", requireAdmin, async (req, res): Promise<void> => {
  const { clientId, siteId, clientName, clientEmail, clientAddress, lineItems, taxAmount, dueDate, notes } = req.body;
  if (!clientName || !lineItems || !dueDate) {
    res.status(400).json({ error: "Bad Request", message: "clientName, lineItems, dueDate required" });
    return;
  }
  const { subtotal, total, processingFeeRate, processingFeeAmount } = await calcTotals(lineItems, siteId || null);
  const [invoice] = await db.insert(invoicesTable).values({
    invoiceNumber: generateInvoiceNumber(),
    clientId: clientId || null,
    siteId: siteId || null,
    clientName,
    clientEmail: clientEmail || null,
    clientAddress: clientAddress || null,
    lineItems,
    subtotal: String(subtotal),
    taxAmount: "0",
    totalAmount: String(total),
    processingFeeRate: processingFeeRate !== null ? String(processingFeeRate) : null,
    processingFeeAmount: processingFeeAmount !== null ? String(processingFeeAmount) : null,
    status: "draft",
    dueDate,
    notes: notes || null,
  }).returning();
  res.status(201).json(invoice);
});

// Generate (or refresh) an invoice for a site from APPROVED time entries.
//
// Two modes:
//   Weekly path:  { siteId, weekStart }        → upsertWeeklyInvoice (idempotent, auto-synced)
//   Custom path:  { siteId, periodStart, periodEnd } → upsertCustomPeriodInvoice (new draft each call, autoSynced=false)
//
// The weekly path delegates to the same upsert the time-entry approval hook
// uses so manual + auto behave identically. The custom path is for non-weekly
// billing cycles and always produces a fresh draft.
router.post("/invoices/generate", requireAdmin, async (req, res): Promise<void> => {
  const { siteId, weekStart, periodStart, periodEnd } = req.body;
  if (!siteId) {
    res.status(400).json({ error: "Bad Request", message: "siteId is required" });
    return;
  }

  // --- Custom period path ---
  if (periodStart || periodEnd) {
    if (!periodStart || !periodEnd) {
      res.status(400).json({ error: "Bad Request", message: "periodStart and periodEnd must both be provided together" });
      return;
    }
    const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoDateRe.test(String(periodStart)) || !isoDateRe.test(String(periodEnd))) {
      res.status(400).json({ error: "Bad Request", message: "periodStart and periodEnd must be YYYY-MM-DD" });
      return;
    }
    if (String(periodEnd) < String(periodStart)) {
      res.status(400).json({ error: "Bad Request", message: "periodEnd must be on or after periodStart" });
      return;
    }

    // Double-billing guard: find existing non-void invoices for this site
    // whose period overlaps the requested range. Overlap = existing.start <=
    // requested.end AND existing.end >= requested.start (inclusive dates).
    // We still create the new draft (adjustment drafts are a supported
    // workflow) but return the conflicting ids so the UI can warn the admin.
    const overlapping = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.siteId, String(siteId)),
          ne(invoicesTable.status, "void"),
          lte(invoicesTable.periodStart, String(periodEnd)),
          gte(invoicesTable.periodEnd, String(periodStart)),
        ),
      );

    const result = await upsertCustomPeriodInvoice(String(siteId), String(periodStart), String(periodEnd));

    if (result.status === "skipped") {
      if (result.reason === "site not found") {
        res.status(404).json({ error: "Not Found", message: "Site not found" });
        return;
      }
      if (result.reason === "site has no client" || result.reason === "client not found") {
        res.status(400).json({ error: "Bad Request", message: "Site has no linked client" });
        return;
      }
      if (result.reason === "no priced entries") {
        res.status(400).json({
          error: "Bad Request",
          message: "Cannot generate invoice: no approved time entries with a bill rate in this period. Ensure approved entries exist and the site has a default bill rate.",
        });
        return;
      }
      res.status(400).json({ error: "Bad Request", message: result.reason });
      return;
    }

    const [withSite] = await db
      .select()
      .from(invoicesTable)
      .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
      .where(eq(invoicesTable.id, result.invoiceId));
    res.status(201).json({
      ...withSite?.invoices,
      siteName: withSite?.sites?.name,
      overlappingInvoiceIds: overlapping.map((o) => o.id),
      ...(result.status === "created" && result.unpricedHours
        ? { unpricedHours: result.unpricedHours }
        : {}),
    });
    return;
  }

  // --- Weekly path (existing behaviour) ---
  if (!weekStart) {
    res.status(400).json({ error: "Bad Request", message: "siteId and weekStart required (or siteId + periodStart + periodEnd for a custom period)" });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekStart))) {
    res.status(400).json({ error: "Bad Request", message: "weekStart must be YYYY-MM-DD" });
    return;
  }

  const result = await upsertWeeklyInvoice(String(siteId), String(weekStart));

  // Preserve the prior route's error contract: 404 for missing site,
  // 400 with the legacy "no bill rate on file" wording for unpriced
  // entries, so existing mobile/admin callers and tests keep working.
  if (result.status === "skipped" && !result.invoiceId) {
    if (result.reason === "site not found") {
      res.status(404).json({ error: "Not Found", message: "Site not found" });
      return;
    }
    if (result.reason === "site has no client" || result.reason === "client not found") {
      res.status(400).json({ error: "Bad Request", message: "Site has no linked client" });
      return;
    }
    if (result.reason === "no priced entries") {
      res.status(400).json({
        error: "Bad Request",
        message: "Cannot generate invoice: no bill rate on file. Set a per-license-level rate on the site's rate card, or fall back to the site's default bill rate.",
      });
      return;
    }
    if (result.reason === "invalid weekStart") {
      res.status(400).json({ error: "Bad Request", message: "weekStart must be YYYY-MM-DD" });
      return;
    }
    if (result.reason === "non_weekly_billing_cycle") {
      res.status(400).json({
        error: "Bad Request",
        message: "This client uses a non-weekly billing cycle. Use periodStart + periodEnd to generate a custom-period invoice instead.",
      });
      return;
    }
    res.status(400).json({ error: "Bad Request", message: result.reason });
    return;
  }
  if (result.status === "skipped") {
    // Existing draft is locked or hand-edited — return it as-is so the
    // caller's UI can show "already on file" without an error.
    const [existing] = await db
      .select()
      .from(invoicesTable)
      .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
      .where(eq(invoicesTable.id, result.invoiceId!));
    res.status(200).json({ ...existing?.invoices, siteName: existing?.sites?.name, skippedReason: result.reason });
    return;
  }

  // Both "created" and "updated" are success — return 201 to match the
  // OpenAPI contract this route has always advertised. Idempotency
  // (re-running for the same week returns the same row) is now a
  // server-side guarantee, not a contract change.
  const [withSite] = await db
    .select()
    .from(invoicesTable)
    .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
    .where(eq(invoicesTable.id, result.invoiceId));
  res.status(201).json({
    ...withSite?.invoices,
    siteName: withSite?.sites?.name,
    overlappingInvoiceIds:
      (result.status === "created" || result.status === "updated"
        ? result.overlappingInvoiceIds
        : undefined) ?? [],
    ...((result.status === "created" || result.status === "updated") && result.unpricedHours
      ? { unpricedHours: result.unpricedHours }
      : {}),
  });
});

// The individual work sessions (officer + subcontractor clock-ins) behind an
// invoice's line items — the Invoice Board drill-down. Read-only: recomputes
// the entries with the SAME shared helper + business-timezone window the
// generators use, then reports whether they still reconcile with the stored
// line items (they won't for hand-edited invoices or entries changed /
// un-approved after generation). An invoice with no linked site or period
// returns an empty, clearly-flagged result rather than an error.
router.get("/invoices/:id/entries", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [inv] = await db
    .select({
      id: invoicesTable.id,
      siteId: invoicesTable.siteId,
      periodStart: invoicesTable.periodStart,
      periodEnd: invoicesTable.periodEnd,
      lineItems: invoicesTable.lineItems,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  if (!inv) { res.status(404).json({ error: "Not Found" }); return; }

  const toIso = (v: unknown): string | null =>
    typeof v === "string" ? v : v instanceof Date ? v.toISOString().slice(0, 10) : null;
  const periodStart = toIso(inv.periodStart);
  const periodEnd = toIso(inv.periodEnd);
  const window = inv.siteId && periodStart && periodEnd ? invoicePeriodWindow(periodStart, periodEnd) : null;

  if (!inv.siteId || !window) {
    res.json({
      unresolved: true,
      reason: !inv.siteId
        ? "This invoice has no linked site, so its line items cannot be traced back to time entries."
        : "This invoice has no valid billing period, so its line items cannot be traced back to time entries.",
      reconciled: false,
      unpricedHours: 0,
      entries: [],
    });
    return;
  }

  const [site] = await db
    .select({ defaultBillRate: sitesTable.defaultBillRate })
    .from(sitesTable)
    .where(eq(sitesTable.id, inv.siteId));
  const siteBillRate = parseFloat(String(site?.defaultBillRate ?? "0"));

  const periodEntries = await collectInvoicePeriodEntries(inv.siteId, window.start, window.end, siteBillRate);
  const { lineItems: computed, unpricedHours } = buildLineItemsFromEntries(periodEntries);

  // Reconciliation: the invoice still matches the live entries iff the
  // recomputed line items are (as a multiset of description/hours/rate)
  // identical to the stored ones. Hand-edited invoices, un-approved or
  // edited entries, and rate changes all break this.
  const stored = (Array.isArray(inv.lineItems) ? inv.lineItems : []) as InvoiceLineItem[];
  const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const reconciled =
    stored.length === computed.length &&
    computed.every((c) =>
      stored.some(
        (s) =>
          s.description === c.description &&
          close(parseFloat(String(s.hours ?? 0)) || 0, c.hours) &&
          close(parseFloat(String(s.rate ?? 0)) || 0, c.rate),
      ),
    );

  res.json({
    unresolved: false,
    reconciled,
    unpricedHours: Math.round(unpricedHours * 100) / 100,
    entries: periodEntries.map((e) => ({
      kind: e.kind,
      entryId: e.entryId,
      workerName: e.workerName,
      description: e.description,
      clockIn: e.clockIn.toISOString(),
      clockOut: e.clockOut ? e.clockOut.toISOString() : null,
      hours: e.hours,
      rate: e.rate,
      level: e.level,
      unpriced: e.unpriced,
      billable: e.billable,
    })),
  });
});

// Stream a branded PDF for a single invoice — used by the admin portal's
// "Download PDF" button. No state is mutated; call POST /invoices/:id/send
// to email + mark sent in one step.
router.get("/invoices/:id/pdf", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [row] = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      clientName: invoicesTable.clientName,
      clientEmail: invoicesTable.clientEmail,
      clientAddress: invoicesTable.clientAddress,
      siteName: sitesTable.name,
      siteId: invoicesTable.siteId,
      autoSynced: invoicesTable.autoSynced,
      periodStart: invoicesTable.periodStart,
      periodEnd: invoicesTable.periodEnd,
      dueDate: invoicesTable.dueDate,
      createdAt: invoicesTable.createdAt,
      lineItems: invoicesTable.lineItems,
      subtotal: invoicesTable.subtotal,
      taxAmount: invoicesTable.taxAmount,
      totalAmount: invoicesTable.totalAmount,
      processingFeeRate: invoicesTable.processingFeeRate,
      processingFeeAmount: invoicesTable.processingFeeAmount,
      notes: invoicesTable.notes,
    })
    .from(invoicesTable)
    .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
    .where(eq(invoicesTable.id, id));

  if (!row) { res.status(404).json({ error: "Not Found" }); return; }

  const periodStartStr = row.periodStart ? (typeof row.periodStart === "string" ? row.periodStart : (row.periodStart as Date).toISOString().slice(0, 10)) : "";
  const freshItems = await refreshLineItemsIfStale(row.id, row.siteId ?? null, row.autoSynced, row.lineItems as InvoiceLineItem[] | null, periodStartStr);

  const { filename, stream } = buildInvoicePdf({
    ...row,
    periodStart: periodStartStr,
    periodEnd: row.periodEnd ? (typeof row.periodEnd === "string" ? row.periodEnd : (row.periodEnd as Date).toISOString().slice(0, 10)) : "",
    lineItems: freshItems,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  stream.pipe(res);
  stream.on("error", (err) => {
    req.log.error({ err }, "[invoicePdf] stream error");
    if (!res.headersSent) res.status(500).json({ error: "PDF generation failed" });
  });
});

// Email the invoice PDF to the client and mark status='sent'.
// Body: { email?: string }  — uses stored clientEmail if not supplied;
// returns { emailSent, emailStatus, emailAddress, invoiceNumber }.
// If SMTP is not configured, still marks the invoice sent and returns
// emailSent:false so the admin can send the PDF manually.
router.post("/invoices/:id/send", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { email: overrideEmail } = req.body as { email?: string };

  const [row] = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      status: invoicesTable.status,
      clientName: invoicesTable.clientName,
      clientEmail: invoicesTable.clientEmail,
      clientAddress: invoicesTable.clientAddress,
      siteName: sitesTable.name,
      siteId: invoicesTable.siteId,
      autoSynced: invoicesTable.autoSynced,
      periodStart: invoicesTable.periodStart,
      periodEnd: invoicesTable.periodEnd,
      dueDate: invoicesTable.dueDate,
      createdAt: invoicesTable.createdAt,
      lineItems: invoicesTable.lineItems,
      subtotal: invoicesTable.subtotal,
      taxAmount: invoicesTable.taxAmount,
      totalAmount: invoicesTable.totalAmount,
      processingFeeRate: invoicesTable.processingFeeRate,
      processingFeeAmount: invoicesTable.processingFeeAmount,
      notes: invoicesTable.notes,
    })
    .from(invoicesTable)
    .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
    .where(eq(invoicesTable.id, id));

  if (!row) { res.status(404).json({ error: "Not Found" }); return; }
  if (row.status === "void") {
    res.status(409).json({ error: "Conflict", message: "Cannot send a voided invoice." });
    return;
  }

  const recipient = overrideEmail?.trim() || row.clientEmail?.trim() || null;

  const sendPeriodStartStr = row.periodStart ? (typeof row.periodStart === "string" ? row.periodStart : (row.periodStart as Date).toISOString().slice(0, 10)) : "";
  // Refresh line items before marking sent so the emailed PDF has level data.
  const freshSendItems = await refreshLineItemsIfStale(row.id, row.siteId ?? null, row.autoSynced, row.lineItems as InvoiceLineItem[] | null, sendPeriodStartStr);

  // Mark sent immediately — even when SMTP isn't configured the admin needs
  // to be able to flag it as "sent via other channel".
  const [updated] = await db
    .update(invoicesTable)
    .set({ status: "sent", autoSynced: false })
    .where(eq(invoicesTable.id, id))
    .returning();

  if (!recipient) {
    res.json({
      emailSent: false,
      emailStatus: "no_recipient",
      emailAddress: null,
      invoiceNumber: row.invoiceNumber,
      status: updated.status,
      message: "Invoice marked sent. No client email on file — add one to the invoice to email the PDF.",
    });
    return;
  }

  // Update the stored email if an override was provided.
  if (overrideEmail?.trim() && overrideEmail.trim() !== row.clientEmail) {
    await db.update(invoicesTable)
      .set({ clientEmail: overrideEmail.trim() })
      .where(eq(invoicesTable.id, id));
  }

  // Build PDF into a Buffer for the attachment.
  const { buffer, filename } = buildInvoicePdf({
    ...row,
    clientEmail: recipient,
    periodStart: sendPeriodStartStr,
    periodEnd: row.periodEnd ? (typeof row.periodEnd === "string" ? row.periodEnd : (row.periodEnd as Date).toISOString().slice(0, 10)) : "",
    lineItems: freshSendItems,
  });

  let pdfBuf: Buffer;
  try {
    pdfBuf = await buffer();
  } catch (err) {
    req.log.error({ err }, "[invoiceSend] PDF build failed");
    res.status(500).json({ error: "PDF generation failed", invoiceNumber: row.invoiceNumber });
    return;
  }

  const totalDisplay = parseFloat(String(row.totalAmount ?? "0")).toLocaleString("en-US", {
    style: "currency", currency: "USD",
  });
  const period = `${row.periodStart} to ${row.periodEnd}`;
  const feeAmt = parseFloat(String(row.processingFeeAmount ?? "0"));
  const feeRt = parseFloat(String(row.processingFeeRate ?? "0"));
  const feeDisplay = feeAmt > 0
    ? feeAmt.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : null;
  const feeLabel = `Processing fee${feeRt > 0 ? ` (${feeRt}%)` : ""}`;

  const emailResult = await sendEmailDetailed({
    to: recipient,
    // The From address is pinned to the verified sending domain (RESEND_FROM /
    // SMTP_FROM) and is often a no-reply/system mailbox. Point replies at the
    // billing inbox so a client hitting "Reply" reaches accounts receivable
    // rather than the sending domain's catch-all.
    replyTo: brand.billingEmail,
    subject: `Invoice ${row.invoiceNumber} — ${brand.companyName}`,
    text: [
      `Dear ${row.clientName ?? "Client"},`,
      "",
      `Please find attached invoice ${row.invoiceNumber} for security services provided during ${period}.`,
      "",
      `${feeDisplay ? `${feeLabel}: ${feeDisplay}\n` : ""}Invoice total: ${totalDisplay}${row.dueDate ? `\nDue date:      ${row.dueDate}` : ""}`,
      "",
      `Please reference the invoice number on your payment. For questions, contact ${brand.billingEmail}.`,
      "",
      `— ${brand.companyName}${brand.companyLicense ? ` · ${brand.companyLicense}` : ""}`,
    ].join("\n"),
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:${brand.colorNavy}">
        <div style="background:${brand.colorNavy};padding:20px 24px;border-radius:4px 4px 0 0">
          <h2 style="color:${brand.colorGold};margin:0;font-size:18px">${escHtml(brand.companyName)}</h2>
          <p style="color:${brand.colorCream};margin:4px 0 0;font-size:12px">${escHtml(brand.tagline)}</p>
          ${brand.companyLicense ? `<p style="color:${brand.colorCream};margin:2px 0 0;font-size:11px">${escHtml(brand.companyLicense)}</p>` : ""}
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 4px 4px">
          <p>Dear ${escHtml(row.clientName ?? "Client")},</p>
          <p>Please find attached invoice <strong>${escHtml(row.invoiceNumber)}</strong> for security services provided during <strong>${escHtml(period)}</strong>.</p>
          <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid ${brand.colorGold};margin:18px 0;border-radius:4px">
            ${feeDisplay ? `<div><strong>${escHtml(feeLabel)}:</strong> ${escHtml(feeDisplay)}</div>` : ""}
            <div><strong>Invoice total:</strong> ${escHtml(totalDisplay)}</div>
            ${row.dueDate ? `<div><strong>Due date:</strong> ${escHtml(row.dueDate)}</div>` : ""}
            <div><strong>Invoice #:</strong> ${escHtml(row.invoiceNumber)}</div>
          </div>
          <p style="color:#555;font-size:13px">Please reference the invoice number on your payment. For questions, contact <a href="mailto:${escHtml(brand.billingEmail)}">${escHtml(brand.billingEmail)}</a>.</p>
          <hr style="border:none;border-top:2px solid ${brand.colorGold};margin:20px 0"/>
          <p style="color:${brand.colorNavy};font-weight:bold;margin:0;font-size:13px">${escHtml(brand.companyName)}${brand.companyLicense ? ` · ${escHtml(brand.companyLicense)}` : ""}</p>
        </div>
      </div>
    `,
    attachments: [{ filename, content: pdfBuf, contentType: "application/pdf" }],
  });

  req.log.info(
    { invoiceId: id, invoiceNumber: row.invoiceNumber, to: recipient, emailStatus: emailResult.status },
    "[invoiceSend] invoice sent",
  );

  res.json({
    emailSent: emailResult.ok,
    emailStatus: emailResult.status,
    emailAddress: recipient,
    invoiceNumber: row.invoiceNumber,
    status: updated.status,
    ...(emailResult.error ? { emailError: emailResult.error } : {}),
  });
});

type InvoiceLineItem = {
  description: string;
  level?: number | null;
  hours?: number | null;
  rate?: number | null;
  amount: number;
};

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Recalculate the processing fee fields for a sent/overdue invoice using the
// site's current salesTaxEnabled + salesTaxRate settings. Updates
// processingFeeRate, processingFeeAmount, and totalAmount in-place.
// Safe to call on paid invoices too (returns the unchanged row with a flag),
// but will not mutate them — paid invoices are a settled financial record.
router.post("/invoices/:id/recalculate-fee", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [row] = await db
    .select({
      id: invoicesTable.id,
      status: invoicesTable.status,
      siteId: invoicesTable.siteId,
      lineItems: invoicesTable.lineItems,
      subtotal: invoicesTable.subtotal,
      processingFeeRate: invoicesTable.processingFeeRate,
      processingFeeAmount: invoicesTable.processingFeeAmount,
      totalAmount: invoicesTable.totalAmount,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Not Found" });
    return;
  }

  // Paid invoices are settled — do not mutate, return as-is with a flag.
  if (row.status === "paid") {
    res.status(409).json({
      error: "Conflict",
      message: "Cannot recalculate fee on a paid invoice — the total is a settled financial record.",
    });
    return;
  }
  if (row.status === "void") {
    res.status(409).json({
      error: "Conflict",
      message: "Cannot recalculate fee on a voided invoice.",
    });
    return;
  }

  const lineItems = (row.lineItems as Array<{ description: string; hours?: number; rate?: number; amount: number }> | null) ?? [];
  const { subtotal, total, processingFeeRate, processingFeeAmount } = await calcTotals(lineItems, row.siteId ?? null);

  const [updated] = await db
    .update(invoicesTable)
    .set({
      subtotal: String(subtotal),
      totalAmount: String(total),
      processingFeeRate: processingFeeRate !== null ? String(processingFeeRate) : null,
      processingFeeAmount: processingFeeAmount !== null ? String(processingFeeAmount) : null,
    })
    .where(eq(invoicesTable.id, id))
    .returning();

  res.json({
    ...updated,
    feeRecalculated: true,
    previousTotal: row.totalAmount,
    previousFeeAmount: row.processingFeeAmount,
  });
});

router.put("/invoices/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { clientEmail, clientAddress, lineItems, status, dueDate, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (clientEmail !== undefined) updates.clientEmail = clientEmail;
  if (clientAddress !== undefined) updates.clientAddress = clientAddress;
  if (lineItems) {
    // Fetch the invoice's siteId so calcTotals can auto-apply the per-site fee.
    const [existing] = await db
      .select({ siteId: invoicesTable.siteId })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id));
    const { subtotal, total, processingFeeRate, processingFeeAmount } = await calcTotals(lineItems, existing?.siteId ?? null);
    updates.lineItems = lineItems;
    updates.subtotal = String(subtotal);
    updates.taxAmount = "0";
    updates.totalAmount = String(total);
    updates.processingFeeRate = processingFeeRate !== null ? String(processingFeeRate) : null;
    updates.processingFeeAmount = processingFeeAmount !== null ? String(processingFeeAmount) : null;
    // Admin hand-edited the billable totals — opt this row out of
    // future auto-sync so the next time-entry approval can't clobber
    // their numbers. The weekly lock job will still freeze it.
    updates.autoSynced = false;
  }
  if (status) {
    updates.status = status;
    if (status === "paid") updates.paidAt = new Date();
    // Any explicit status change past 'draft' also opts out of resync.
    if (status !== "draft") updates.autoSynced = false;
  }
  if (dueDate) updates.dueDate = dueDate;
  if (notes !== undefined) updates.notes = notes;

  const [invoice] = await db.update(invoicesTable).set(updates).where(eq(invoicesTable.id, id)).returning();
  if (!invoice) { res.status(404).json({ error: "Not Found" }); return; }
  res.json(invoice);
});

export default router;
