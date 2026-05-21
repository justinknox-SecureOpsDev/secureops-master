import { Router, type IRouter } from "express";
import { eq, and, ilike } from "drizzle-orm";
import { db, invoicesTable, sitesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { upsertWeeklyInvoice } from "../lib/invoiceSync";

const router: IRouter = Router();

function generateInvoiceNumber(): string {
  const now = new Date();
  const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const suffix = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
  return `${prefix}-${suffix}`;
}

function calcTotals(lineItems: Array<{ description: string; hours?: number; rate?: number; amount: number }>, taxAmount: number) {
  const subtotal = lineItems.reduce((s, item) => {
    const amount = item.amount ?? (item.hours && item.rate ? item.hours * item.rate : 0);
    return s + amount;
  }, 0);
  const total = subtotal + (taxAmount || 0);
  return { subtotal: Math.round(subtotal * 100) / 100, total: Math.round(total * 100) / 100 };
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

router.get("/invoices", requireAdmin, async (req, res): Promise<void> => {
  const { status, clientName, siteId, clientId } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (status) conditions.push(eq(invoicesTable.status, status));
  if (clientName) conditions.push(ilike(invoicesTable.clientName, `%${clientName}%`));
  if (siteId) conditions.push(eq(invoicesTable.siteId, siteId));
  if (clientId) conditions.push(eq(invoicesTable.clientId, clientId));

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
  const { subtotal, total } = calcTotals(lineItems, taxAmount || 0);
  const [invoice] = await db.insert(invoicesTable).values({
    invoiceNumber: generateInvoiceNumber(),
    clientId: clientId || null,
    siteId: siteId || null,
    clientName,
    clientEmail: clientEmail || null,
    clientAddress: clientAddress || null,
    lineItems,
    subtotal: String(subtotal),
    taxAmount: String(taxAmount || 0),
    totalAmount: String(total),
    status: "draft",
    dueDate,
    notes: notes || null,
  }).returning();
  res.status(201).json(invoice);
});

// Generate (or refresh) the weekly invoice for a site from APPROVED time
// entries. Delegates to the same upsert the time-entry approval hook uses
// so manual + auto behave identically: re-running for the same (siteId,
// weekStart) updates the existing draft instead of creating duplicates,
// and once an admin hand-edits the draft this becomes a no-op.
router.post("/invoices/generate", requireAdmin, async (req, res): Promise<void> => {
  const { siteId, weekStart } = req.body;
  if (!siteId || !weekStart) {
    res.status(400).json({ error: "Bad Request", message: "siteId and weekStart required" });
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
  res.status(201).json({ ...withSite?.invoices, siteName: withSite?.sites?.name });
});

router.put("/invoices/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { clientEmail, clientAddress, lineItems, taxAmount, status, dueDate, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (clientEmail !== undefined) updates.clientEmail = clientEmail;
  if (clientAddress !== undefined) updates.clientAddress = clientAddress;
  if (lineItems) {
    const { subtotal, total } = calcTotals(lineItems, taxAmount ?? 0);
    updates.lineItems = lineItems;
    updates.subtotal = String(subtotal);
    updates.taxAmount = String(taxAmount ?? 0);
    updates.totalAmount = String(total);
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
