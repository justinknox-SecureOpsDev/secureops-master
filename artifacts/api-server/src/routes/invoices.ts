import { Router, type IRouter } from "express";
import { eq, and, or, ilike, gte, lte, lt } from "drizzle-orm";
import { db, invoicesTable, clientsTable, sitesTable, shiftsTable, timeEntriesTable, usersTable } from "@workspace/db";
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

// Generate weekly invoice for a site from APPROVED time entries.
// Line items are grouped by shift title (the "assignment" name) at billRate.
router.post("/invoices/generate", requireAdmin, async (req, res): Promise<void> => {
  const { siteId, weekStart } = req.body;
  if (!siteId || !weekStart) {
    res.status(400).json({ error: "Bad Request", message: "siteId and weekStart required" });
    return;
  }
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) { res.status(400).json({ error: "Bad Request", message: "weekStart must be YYYY-MM-DD" }); return; }
  const end = addDays(start, 7);

  const [site] = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      address: sitesTable.address,
      clientId: sitesTable.clientId,
      defaultBillRate: sitesTable.defaultBillRate,
    })
    .from(sitesTable)
    .where(eq(sitesTable.id, siteId));
  if (!site) { res.status(404).json({ error: "Not Found", message: "Site not found" }); return; }

  const [client] = site.clientId
    ? await db.select().from(clientsTable).where(eq(clientsTable.id, site.clientId))
    : [undefined];
  if (!client) { res.status(400).json({ error: "Bad Request", message: "Site has no linked client" }); return; }

  // Approved hours billed at the SITE's bill rate (hour-for-hour against
  // every entry's actual hoursWorked). The site rate is the single source
  // of truth so a client's invoice can never drift from the contracted
  // hourly rate just because one shift was posted with a stale billRate.
  // shifts.billRate is kept as a defensive fallback for legacy sites that
  // were created before defaultBillRate existed.
  //
  // We also include ad-hoc geo clock-ins (no linked shift): a time entry
  // whose own siteId resolves to this site counts. That way every approved
  // working hour at the site shows up on the invoice.
  const siteBillRate = parseFloat(String(site.defaultBillRate ?? "0"));

  const entries = await db
    .select({
      id: timeEntriesTable.id,
      hoursWorked: timeEntriesTable.hoursWorked,
      shiftBillRate: shiftsTable.billRate,
      employeeFirst: usersTable.firstName,
      employeeLast: usersTable.lastName,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(and(
      or(eq(shiftsTable.siteId, siteId), eq(timeEntriesTable.siteId, siteId)),
      eq(timeEntriesTable.approvalStatus, "approved"),
      gte(timeEntriesTable.clockInTime, start),
      lt(timeEntriesTable.clockInTime, end),
    ));

  if (entries.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No approved time entries for this site/week" });
    return;
  }

  // Resolve the per-entry billable rate. Prefer the shift's billRate —
  // since the new per-site rate card populates it from the site+license
  // combo at shift-create time, this gives the right answer for L2 vs L3
  // vs PPO shifts at the same site (which the single site.defaultBillRate
  // can't express). Fall back to site.defaultBillRate if the shift has no
  // rate set (legacy / ad-hoc geo clock-ins with no shiftId). If neither
  // exists we refuse the whole invoice rather than silently sending the
  // client a $0 line.
  type Priced = { hours: number; rate: number; officerName: string };
  const priced: Priced[] = [];
  const unrated: string[] = [];
  for (const e of entries) {
    const hours = parseFloat(String(e.hoursWorked ?? "0"));
    if (!isFinite(hours) || hours <= 0) continue; // skip open/zero entries
    const shiftBill = parseFloat(String(e.shiftBillRate ?? "0"));
    const rate = shiftBill > 0 ? shiftBill : siteBillRate;
    const officerName = [e.employeeFirst, e.employeeLast].filter(Boolean).join(" ") || "Unassigned officer";
    if (rate <= 0) {
      unrated.push(officerName);
      continue;
    }
    priced.push({ hours, rate, officerName });
  }
  if (priced.length === 0) {
    res.status(400).json({
      error: "Bad Request",
      message: "Cannot generate invoice: no bill rate on file. Set a per-license-level rate on the site's rate card, or fall back to the site's default bill rate.",
    });
    return;
  }
  if (unrated.length > 0) {
    req.log?.warn(
      { siteId, weekStart, unratedCount: unrated.length },
      "Some approved time entries had no resolvable bill rate and were excluded from the invoice",
    );
  }

  // One line per (officer × rate). Reads naturally on the PDF:
  //   "Smith, John  —  16.50h × $42.00  =  $693.00"
  // If the client renegotiated mid-week and two rates apply, each officer
  // gets one line per rate so the breakdown is auditable.
  const groups = new Map<string, { description: string; hours: number; rate: number; amount: number }>();
  for (const p of priced) {
    const key = `${p.officerName}__${p.rate}`;
    const cur = groups.get(key) ?? { description: p.officerName, hours: 0, rate: p.rate, amount: 0 };
    cur.hours += p.hours;
    cur.amount += p.hours * p.rate;
    groups.set(key, cur);
  }
  const lineItems = Array.from(groups.values())
    .sort((a, b) => a.description.localeCompare(b.description))
    .map((g) => ({
      description: g.description,
      hours: Math.round(g.hours * 100) / 100,
      rate: g.rate,
      amount: Math.round(g.amount * 100) / 100,
    }));
  const { subtotal, total } = calcTotals(lineItems, 0);

  const periodStart = isoDate(start);
  const periodEnd = isoDate(addDays(start, 6));
  const dueDate = isoDate(addDays(new Date(), client.paymentTermsDays));

  const [invoice] = await db.insert(invoicesTable).values({
    invoiceNumber: generateInvoiceNumber(),
    clientId: client.id,
    siteId: site.id,
    periodStart,
    periodEnd,
    clientName: client.name,
    clientEmail: client.contactEmail,
    clientAddress: client.billingAddress,
    lineItems,
    subtotal: String(subtotal),
    taxAmount: "0",
    totalAmount: String(total),
    status: "draft",
    dueDate,
    notes: `${site.name} — week of ${periodStart}`,
  }).returning();

  res.status(201).json({ ...invoice, siteName: site.name });
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
