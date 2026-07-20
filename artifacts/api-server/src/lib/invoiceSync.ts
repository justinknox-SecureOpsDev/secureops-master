import { and, eq, gte, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  invoicesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  usersTable,
  subcontractorTimeEntriesTable,
  type TimeEntry,
  type SubcontractorTimeEntry,
} from "@workspace/db";
import { logger } from "./logger";
import { getFederalHolidayName, HOLIDAY_PAY_MULTIPLIER } from "./holidays";

/**
 * Auto-population of weekly client invoices (May 2026).
 *
 * Lifecycle (per the product spec):
 *   1. Admin approves a time entry  → upsertWeeklyInvoiceForTimeEntry()
 *      finds-or-creates a draft invoice for that (siteId, ISO-week) and
 *      rebuilds its line items from every currently-approved entry in
 *      that week. Idempotent: re-running yields the same totals.
 *   2. Admin manually edits the invoice (lineItems / subtotal / tax)
 *      → invoicesTable.autoSynced flips to false. From then on, new
 *      approvals for the same week skip this row (and start the next
 *      week's invoice if their week differs). Prevents the system from
 *      clobbering a hand-tuned bill.
 *   3. Week ends (Mon 00:00 UTC) → scheduledJobs.ts calls
 *      lockEndedWeekInvoices() which stamps locked_at on every draft
 *      whose period has ended. Locked rows are never re-synced; the
 *      next approval rolls into a fresh draft for the new week.
 *
 * Mutability contract (used by both the dedicated PUT /invoices/:id
 * handler and the generic /admin/tables/invoices PUT): an invoice is
 * "syncable" iff status === 'draft' AND locked_at IS NULL AND
 * auto_synced === true.
 */

const SYNCABLE_STATUS = "draft";

const SYNCED_LINE_KEYS = new Set([
  "lineItems",
  "line_items",
  "subtotal",
  "taxAmount",
  "tax_amount",
  "totalAmount",
  "total_amount",
]);

/**
 * Returns true when an admin edit body touches a field that drives the
 * auto-synced totals. Callers should mirror the edit into autoSynced=false
 * BEFORE writing, so the very next approval skips this invoice.
 */
export function adminEditBreaksAutoSync(body: Record<string, unknown>): boolean {
  for (const k of Object.keys(body)) {
    if (SYNCED_LINE_KEYS.has(k)) return true;
  }
  return false;
}

/** Monday 00:00 UTC of the week containing `d`, as YYYY-MM-DD. */
export function weekStartIsoUtc(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const offset = day === 0 ? 6 : day - 1;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - offset);
  return m.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function generateInvoiceNumber(): string {
  const now = new Date();
  const prefix = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const suffix = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
  return `${prefix}-${suffix}`;
}

export type UpsertResult =
  | { status: "skipped"; reason: string; invoiceId?: string }
  | { status: "created"; invoiceId: string; totalAmount: number; lineCount: number }
  | { status: "updated"; invoiceId: string; totalAmount: number; lineCount: number }
  | { status: "deleted"; invoiceId: string; reason: string };

/**
 * Build/refresh the draft invoice for (siteId, weekStartIso).
 *
 *  - Returns `skipped` if the site has no linked client, no bill rate,
 *    or the existing draft is locked / hand-edited / non-draft.
 *  - If no draft exists and there's at least one priced approved entry,
 *    creates one.
 *  - If a syncable draft exists and there are zero priced entries left
 *    (e.g. all entries un-approved), deletes the empty draft so the
 *    Invoices grid doesn't fill up with $0 rows.
 *
 * Safe to call from request handlers (best-effort, caller should not
 * block its 2xx on this). Failures are logged and swallowed at the
 * caller boundary.
 */
export async function upsertWeeklyInvoice(
  siteId: string,
  weekStartIso: string,
): Promise<UpsertResult> {
  const start = new Date(`${weekStartIso}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    return { status: "skipped", reason: "invalid weekStart" };
  }
  const end = addDaysUtc(start, 7);

  const [site] = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      clientId: sitesTable.clientId,
      defaultBillRate: sitesTable.defaultBillRate,
    })
    .from(sitesTable)
    .where(eq(sitesTable.id, siteId));
  if (!site) return { status: "skipped", reason: "site not found" };
  if (!site.clientId) return { status: "skipped", reason: "site has no client" };

  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, site.clientId));
  if (!client) return { status: "skipped", reason: "client not found" };

  const siteBillRate = parseFloat(String(site.defaultBillRate ?? "0"));

  // Look for a hand-edited draft FIRST. Per product spec, once an admin
  // touches the billable totals we stop auto-touching that row forever;
  // late approvals for the same week are the admin's responsibility to
  // fold in by hand. We never create a parallel auto-draft alongside a
  // manual draft (would double-bill the same hours).
  const [manualDraft] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.siteId, siteId),
        eq(invoicesTable.periodStart, weekStartIso),
        eq(invoicesTable.status, SYNCABLE_STATUS),
        isNull(invoicesTable.lockedAt),
        eq(invoicesTable.autoSynced, false),
      ),
    )
    .limit(1);
  if (manualDraft) {
    logger.warn(
      { siteId, weekStartIso, invoiceId: manualDraft.id },
      "[invoice-sync] skipping manually-edited draft; late-approved entries for this week must be added by hand",
    );
    return { status: "skipped", reason: "manually edited", invoiceId: manualDraft.id };
  }

  // The single active-sync draft, if any. Filtered to match the partial
  // unique index — locked rows are excluded so a new "adjustment draft"
  // can coexist with last week's already-locked-and-sent invoice.
  const [existing] = await db
    .select()
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.siteId, siteId),
        eq(invoicesTable.periodStart, weekStartIso),
        eq(invoicesTable.status, SYNCABLE_STATUS),
        isNull(invoicesTable.lockedAt),
        eq(invoicesTable.autoSynced, true),
      ),
    )
    .limit(1);

  // Pull every approved entry for this site+week, grouped by officer+rate.
  const entries = await db
    .select({
      hoursWorked: timeEntriesTable.hoursWorked,
      clockInTime: timeEntriesTable.clockInTime,
      shiftBillRate: shiftsTable.billRate,
      employeeFirst: usersTable.firstName,
      employeeLast: usersTable.lastName,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(
      and(
        or(eq(shiftsTable.siteId, siteId), eq(timeEntriesTable.siteId, siteId)),
        eq(timeEntriesTable.approvalStatus, "approved"),
        gte(timeEntriesTable.clockInTime, start),
        lt(timeEntriesTable.clockInTime, end),
      ),
    );

  type Group = { description: string; hours: number; rate: number; amount: number };
  const groups = new Map<string, Group>();
  for (const e of entries) {
    const hours = parseFloat(String(e.hoursWorked ?? "0"));
    if (!isFinite(hours) || hours <= 0) continue;
    const shiftBill = parseFloat(String(e.shiftBillRate ?? "0"));
    const baseRate = shiftBill > 0 ? shiftBill : siteBillRate;
    if (baseRate <= 0) continue;
    const officerName =
      [e.employeeFirst, e.employeeLast].filter(Boolean).join(" ") || "Unassigned officer";
    // Federal-holiday premium (1.5×): hours worked on a US federal holiday
    // (clock-in date in PAYROLL_TIMEZONE) are billed at time-and-a-half and
    // split into their own line item so the client sees the premium plainly.
    const holidayName = getFederalHolidayName(e.clockInTime);
    const rate = holidayName ? Math.round(baseRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100 : baseRate;
    const description = holidayName
      ? `${officerName} — Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : officerName;
    const key = `${officerName}__${rate}__${holidayName ?? ""}`;
    const cur = groups.get(key) ?? { description, hours: 0, rate, amount: 0 };
    cur.hours += hours;
    cur.amount += hours * rate;
    groups.set(key, cur);
  }
  // Subcontractor hours (Task #277). Closed entries only (clockOutAt set,
  // hoursWorked > 0) for this site+week. Subcontractors have no shift and
  // no system account, so there's no shift-level billRate to fall back
  // from — they're billed at the site's defaultBillRate. When the site
  // has no default bill rate, these lines are skipped (rate <= 0), exactly
  // like an officer entry whose shift+site can't resolve a rate; if that
  // leaves the whole week with zero priced lines the upsert refuses with
  // "no priced entries" (surfaced as the explicit 400 by the route).
  const subEntries = await db
    .select({
      hoursWorked: subcontractorTimeEntriesTable.hoursWorked,
      clockInAt: subcontractorTimeEntriesTable.clockInAt,
      name: subcontractorTimeEntriesTable.name,
      company: subcontractorTimeEntriesTable.company,
    })
    .from(subcontractorTimeEntriesTable)
    .where(
      and(
        eq(subcontractorTimeEntriesTable.siteId, siteId),
        isNotNull(subcontractorTimeEntriesTable.clockOutAt),
        gte(subcontractorTimeEntriesTable.clockInAt, start),
        lt(subcontractorTimeEntriesTable.clockInAt, end),
      ),
    );
  for (const e of subEntries) {
    const hours = parseFloat(String(e.hoursWorked ?? "0"));
    if (!isFinite(hours) || hours <= 0) continue;
    if (siteBillRate <= 0) continue;
    // Subcontractor hours worked on a federal holiday are billed to the
    // client at the same 1.5× premium as officer hours, split into a
    // dedicated line item.
    const holidayName = getFederalHolidayName(e.clockInAt);
    const rate = holidayName ? Math.round(siteBillRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100 : siteBillRate;
    const label = holidayName
      ? `${e.name} (${e.company}) — subcontractor, Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : `${e.name} (${e.company}) — subcontractor`;
    const key = `sub__${label}__${rate}`;
    const cur = groups.get(key) ?? { description: label, hours: 0, rate, amount: 0 };
    cur.hours += hours;
    cur.amount += hours * rate;
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

  if (lineItems.length === 0) {
    // No billable hours left this week. If an empty draft exists from a
    // prior approval that's since been un-approved, prune it.
    if (existing) {
      await db.delete(invoicesTable).where(eq(invoicesTable.id, existing.id));
      return { status: "deleted", invoiceId: existing.id, reason: "no priced entries" };
    }
    return { status: "skipped", reason: "no priced entries" };
  }

  const subtotal =
    Math.round(lineItems.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const taxAmount = existing ? parseFloat(String(existing.taxAmount ?? "0")) : 0;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;

  const periodEnd = isoDate(addDaysUtc(start, 6));

  if (existing) {
    const [updated] = await db
      .update(invoicesTable)
      .set({
        clientId: client.id,
        clientName: client.name,
        clientEmail: client.contactEmail,
        clientAddress: client.billingAddress,
        periodEnd,
        lineItems,
        subtotal: String(subtotal),
        totalAmount: String(total),
      })
      .where(eq(invoicesTable.id, existing.id))
      .returning();
    return {
      status: "updated",
      invoiceId: updated.id,
      totalAmount: total,
      lineCount: lineItems.length,
    };
  }

  const dueDate = isoDate(addDaysUtc(new Date(), client.paymentTermsDays ?? 30));
  try {
    const [created] = await db
      .insert(invoicesTable)
      .values({
        invoiceNumber: generateInvoiceNumber(),
        clientId: client.id,
        siteId: site.id,
        periodStart: weekStartIso,
        periodEnd,
        clientName: client.name,
        clientEmail: client.contactEmail,
        clientAddress: client.billingAddress,
        lineItems,
        subtotal: String(subtotal),
        taxAmount: String(taxAmount),
        totalAmount: String(total),
        status: "draft",
        dueDate,
        notes: `${site.name} — week of ${weekStartIso}`,
        autoSynced: true,
      })
      .returning();
    return {
      status: "created",
      invoiceId: created.id,
      totalAmount: total,
      lineCount: lineItems.length,
    };
  } catch (err) {
    // Concurrent approval beat us to the insert. The partial unique
    // index `invoices_active_auto_draft_per_week_idx` guarantees only
    // one active-sync draft exists; re-select it and apply our totals
    // as an UPDATE so the latest-arriving tick wins (idempotent).
    const code = (err as { code?: string })?.code;
    if (code !== "23505") throw err;
    const [raceWinner] = await db
      .select({ id: invoicesTable.id, taxAmount: invoicesTable.taxAmount })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.siteId, siteId),
          eq(invoicesTable.periodStart, weekStartIso),
          eq(invoicesTable.status, SYNCABLE_STATUS),
          isNull(invoicesTable.lockedAt),
          eq(invoicesTable.autoSynced, true),
        ),
      )
      .limit(1);
    if (!raceWinner) {
      logger.error({ siteId, weekStartIso }, "[invoice-sync] unique violation but no race-winner row found");
      return { status: "skipped", reason: "concurrent insert lost race" };
    }
    const rwTax = parseFloat(String(raceWinner.taxAmount ?? "0"));
    const rwTotal = Math.round((subtotal + rwTax) * 100) / 100;
    await db
      .update(invoicesTable)
      .set({
        clientId: client.id,
        clientName: client.name,
        clientEmail: client.contactEmail,
        clientAddress: client.billingAddress,
        periodEnd,
        lineItems,
        subtotal: String(subtotal),
        totalAmount: String(rwTotal),
      })
      .where(eq(invoicesTable.id, raceWinner.id));
    return {
      status: "updated",
      invoiceId: raceWinner.id,
      totalAmount: rwTotal,
      lineCount: lineItems.length,
    };
  }
}

/**
 * Resolve (siteId, weekStart) for a time entry and call upsertWeeklyInvoice.
 * Never throws — best-effort hook from the approval handler.
 */
export async function upsertWeeklyInvoiceForTimeEntry(entry: TimeEntry): Promise<UpsertResult | null> {
  try {
    let siteId = entry.siteId ?? null;
    if (!siteId && entry.shiftId) {
      const [s] = await db
        .select({ siteId: shiftsTable.siteId })
        .from(shiftsTable)
        .where(eq(shiftsTable.id, entry.shiftId));
      siteId = s?.siteId ?? null;
    }
    if (!siteId) return null;
    const clockIn = entry.clockInTime ? new Date(entry.clockInTime) : null;
    if (!clockIn || Number.isNaN(clockIn.getTime())) return null;
    const weekStart = weekStartIsoUtc(clockIn);
    const result = await upsertWeeklyInvoice(siteId, weekStart);
    if (result.status === "created" || result.status === "updated") {
      logger.info(
        { siteId, weekStart, invoiceId: result.invoiceId, total: result.totalAmount, lines: result.lineCount, status: result.status },
        "[invoice-sync] draft invoice synced from approval",
      );
    }
    return result;
  } catch (err) {
    logger.warn({ err, timeEntryId: entry.id }, "[invoice-sync] upsert from approval failed");
    return null;
  }
}

/**
 * Resolve (siteId, weekStart) for a subcontractor entry and call
 * upsertWeeklyInvoice. Subcontractor entries anchor directly to a site
 * (no shift), so the site is always present. Keyed on clockInAt week to
 * mirror the officer flow. Never throws — best-effort hook from the
 * subcontractor clock-out handlers.
 */
export async function upsertWeeklyInvoiceForSubcontractorEntry(
  entry: SubcontractorTimeEntry,
): Promise<UpsertResult | null> {
  try {
    if (!entry.siteId) return null;
    const clockIn = entry.clockInAt ? new Date(entry.clockInAt) : null;
    if (!clockIn || Number.isNaN(clockIn.getTime())) return null;
    const weekStart = weekStartIsoUtc(clockIn);
    const result = await upsertWeeklyInvoice(entry.siteId, weekStart);
    if (result.status === "created" || result.status === "updated") {
      logger.info(
        { siteId: entry.siteId, weekStart, invoiceId: result.invoiceId, total: result.totalAmount, lines: result.lineCount, status: result.status },
        "[invoice-sync] draft invoice synced from subcontractor clock-out",
      );
    }
    return result;
  } catch (err) {
    logger.warn({ err, subEntryId: entry.id }, "[invoice-sync] upsert from subcontractor clock-out failed");
    return null;
  }
}

/**
 * Hourly scheduled job — stamp locked_at on every draft whose week has
 * fully elapsed. After locking, the next approval for that site rolls
 * into a fresh draft (the upsert keys on periodStart so it won't find
 * this row). Idempotent: lockedAt is set with IS NULL guard.
 */
export async function lockEndedWeekInvoices(): Promise<void> {
  try {
    const today = isoDate(new Date());
    const locked = await db
      .update(invoicesTable)
      .set({ lockedAt: new Date() })
      .where(
        and(
          eq(invoicesTable.status, "draft"),
          isNull(invoicesTable.lockedAt),
          lt(invoicesTable.periodEnd, today),
        ),
      )
      .returning({ id: invoicesTable.id });
    if (locked.length > 0) {
      logger.info({ count: locked.length }, "[invoice-sync] locked ended-week draft invoices");
    }
  } catch (err) {
    logger.error({ err }, "[invoice-sync] lockEndedWeekInvoices failed");
  }
}
