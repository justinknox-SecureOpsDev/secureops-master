import { Router, type IRouter } from "express";
import { eq, and, ilike, sql } from "drizzle-orm";
import { db, invoicesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

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

router.get("/invoices", requireAdmin, async (req, res): Promise<void> => {
  const { status, clientName } = req.query as { status?: string; clientName?: string };
  const conditions = [];
  if (status) conditions.push(eq(invoicesTable.status, status));
  if (clientName) conditions.push(ilike(invoicesTable.clientName, `%${clientName}%`));

  const rows = conditions.length > 0
    ? await db.select().from(invoicesTable).where(and(...conditions))
    : await db.select().from(invoicesTable);

  res.json(rows);
});

router.post("/invoices", requireAdmin, async (req, res): Promise<void> => {
  const { clientName, clientEmail, clientAddress, lineItems, taxAmount, dueDate, notes } = req.body;
  if (!clientName || !lineItems || !dueDate) {
    res.status(400).json({ error: "Bad Request", message: "clientName, lineItems, dueDate required" });
    return;
  }
  const { subtotal, total } = calcTotals(lineItems, taxAmount || 0);
  const [invoice] = await db.insert(invoicesTable).values({
    invoiceNumber: generateInvoiceNumber(),
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
  }
  if (status) {
    updates.status = status;
    if (status === "paid") updates.paidAt = new Date();
  }
  if (dueDate) updates.dueDate = dueDate;
  if (notes !== undefined) updates.notes = notes;

  const [invoice] = await db.update(invoicesTable).set(updates).where(eq(invoicesTable.id, id)).returning();
  if (!invoice) { res.status(404).json({ error: "Not Found" }); return; }
  res.json(invoice);
});

export default router;
