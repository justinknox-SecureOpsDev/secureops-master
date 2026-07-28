import { and, eq, gte, isNull, isNotNull, lt, lte, ne, not, or, sql } from "drizzle-orm";
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
import { isProcessingFeeEnabled, getProcessingFeeRate } from "./processingFeeConfig";
import { businessTimeZone, businessDateToUtc, businessDateIso, startOfBusinessWeek } from "./businessTime";

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

/**
 * YYYY-MM-DD of the business-TZ (Central) Monday that starts the week
 * containing `d`. Invoices bucket by the SAME business week as payroll and the
 * officer time card, so a Sunday-evening-Central shift (already Monday in UTC)
 * is billed in the same week it is paid — no boundary-sliver drift.
 */
export function weekStartIsoBusiness(d: Date): string {
  const tz = businessTimeZone();
  return businessDateIso(startOfBusinessWeek(d, tz), tz);
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
  | { status: "created"; invoiceId: string; totalAmount: number; lineCount: number; overlappingInvoiceIds?: string[]; unpricedHours?: number }
  | { status: "updated"; invoiceId: string; totalAmount: number; lineCount: number; overlappingInvoiceIds?: string[]; unpricedHours?: number }
  | { status: "deleted"; invoiceId: string; reason: string };

/**
 * Double-billing guard for the WEEKLY path: find existing non-void invoices
 * for this site whose period overlaps [weekStartIso, weekEndIso] but that are
 * NOT keyed to this exact week. Weekly-keyed rows (periodStart = weekStart AND
 * periodEnd = weekEnd) are excluded because locked prior weekly invoices +
 * adjustment drafts for the same week are a supported workflow — the risk this
 * flags is a CUSTOM-period invoice silently covering the same site+week.
 * Overlap = existing.start <= weekEnd AND existing.end >= weekStart
 * (inclusive dates), mirroring the custom-period path's guard.
 */
export async function findWeeklyOverlapInvoiceIds(
  siteId: string,
  weekStartIso: string,
  weekEndIso: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.siteId, siteId),
        ne(invoicesTable.status, "void"),
        lte(invoicesTable.periodStart, weekEndIso),
        gte(invoicesTable.periodEnd, weekStartIso),
        not(
          and(
            eq(invoicesTable.periodStart, weekStartIso),
            eq(invoicesTable.periodEnd, weekEndIso),
          )!,
        ),
      ),
    );
  return rows.map((r) => r.id);
}

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartIso)) {
    return { status: "skipped", reason: "invalid weekStart" };
  }
  // Window by the business-TZ (Central) week so the hours billed here match
  // exactly what payroll pays and the officer's time card shows. A UTC-Monday
  // window would split the Sunday-evening-Central boundary sliver (already
  // Monday in UTC) into a different week than payroll — the same drift Task
  // #601 fixed for payroll. start = Central Monday 00:00 (as a UTC instant);
  // end = the following Central Monday (DST-safe).
  const tz = businessTimeZone();
  const start = businessDateToUtc(weekStartIso, tz);
  if (Number.isNaN(start.getTime())) {
    return { status: "skipped", reason: "invalid weekStart" };
  }
  const end = startOfBusinessWeek(new Date(start.getTime() + 8.5 * 24 * 3600_000), tz);

  const [site] = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      clientId: sitesTable.clientId,
      defaultBillRate: sitesTable.defaultBillRate,
      salesTaxEnabled: sitesTable.salesTaxEnabled,
      salesTaxRate: sitesTable.salesTaxRate,
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

  // Non-weekly clients: suppress auto-sync so stray weekly drafts don't pile up.
  // The admin generates invoices manually via POST /invoices/generate with a custom period.
  if (client.billingCycle && client.billingCycle !== "weekly") {
    logger.debug(
      { siteId, weekStartIso, billingCycle: client.billingCycle },
      "[invoice-sync] skipping weekly auto-sync for non-weekly billing cycle",
    );
    return { status: "skipped", reason: "non_weekly_billing_cycle" };
  }

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
      shiftLevel: shiftsTable.requiredLicenseLevel,
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

  type Group = { description: string; level: number | null; hours: number; rate: number; amount: number };
  const groups = new Map<string, Group>();
  // Approved hours we could NOT price (no shift bill rate AND no site default
  // bill rate). Mirrors the custom-period path: these must be surfaced to the
  // admin — silently dropping them produces an invoice that under-bills with
  // no visible sign anything is wrong.
  let unpricedHours = 0;
  for (const e of entries) {
    const hours = parseFloat(String(e.hoursWorked ?? "0"));
    if (!isFinite(hours) || hours <= 0) continue;
    const shiftBill = parseFloat(String(e.shiftBillRate ?? "0"));
    const baseRate = shiftBill > 0 ? shiftBill : siteBillRate;
    if (baseRate <= 0) { unpricedHours += hours; continue; }
    const officerName =
      [e.employeeFirst, e.employeeLast].filter(Boolean).join(" ") || "Unassigned officer";
    const level = e.shiftLevel ?? null;
    // Federal-holiday premium (1.5×): hours worked on a US federal holiday
    // (clock-in date in PAYROLL_TIMEZONE) are billed at time-and-a-half and
    // split into their own line item so the client sees the premium plainly.
    const holidayName = getFederalHolidayName(e.clockInTime);
    const rate = holidayName ? Math.round(baseRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100 : baseRate;
    const description = holidayName
      ? `${officerName} — Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : officerName;
    const key = `${officerName}__${level ?? ""}__${rate}__${holidayName ?? ""}`;
    const cur = groups.get(key) ?? { description, level, hours: 0, rate, amount: 0 };
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
    if (siteBillRate <= 0) { unpricedHours += hours; continue; }
    // Subcontractor hours worked on a federal holiday are billed to the
    // client at the same 1.5× premium as officer hours, split into a
    // dedicated line item.
    const holidayName = getFederalHolidayName(e.clockInAt);
    const rate = holidayName ? Math.round(siteBillRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100 : siteBillRate;
    const label = holidayName
      ? `${e.name} (${e.company}) — subcontractor, Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : `${e.name} (${e.company}) — subcontractor`;
    const key = `sub__${label}__${rate}`;
    const cur = groups.get(key) ?? { description: label, level: null, hours: 0, rate, amount: 0 };
    cur.hours += hours;
    cur.amount += hours * rate;
    groups.set(key, cur);
  }

  const lineItems = Array.from(groups.values())
    .sort((a, b) => a.description.localeCompare(b.description))
    .map((g) => ({
      description: g.description,
      level: g.level,
      hours: Math.round(g.hours * 100) / 100,
      rate: g.rate,
      amount: Math.round(g.amount * 100) / 100,
    }));

  // Round once, reuse in every return path. Computed BEFORE the empty-week
  // early-return so an all-unpriced week still leaves a log trace — the
  // approval auto-sync hook has no UI, so this warn is its only signal.
  const unpriced = unpricedHours > 0 ? Math.round(unpricedHours * 100) / 100 : 0;
  if (unpriced > 0) {
    logger.warn(
      { siteId, weekStartIso, unpricedHours: unpriced },
      "[invoice-sync] weekly invoice is missing approved hours with no bill rate — set the site's default bill rate",
    );
  }

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
  // Unified fee: platform master switch AND per-site salesTaxEnabled must
  // both be true. The rate comes from the site's salesTaxRate (not the
  // platform-level getProcessingFeeRate singleton), so each site can carry
  // a different percentage. taxAmount is zeroed — it was the old per-site
  // path before this unification; processingFeeAmount is now the single
  // canonical fee column.
  const feeEnabled = isProcessingFeeEnabled() && !!site.salesTaxEnabled;
  const feeRate = feeEnabled ? parseFloat(String(site.salesTaxRate ?? "8.25")) : 0;
  const feeAmount = feeEnabled ? Math.round(subtotal * feeRate / 100 * 100) / 100 : 0;
  const total = Math.round((subtotal + feeAmount) * 100) / 100;

  const periodEnd = isoDate(addDaysUtc(start, 6));

  // Double-billing guard (mirrors the custom-period path): warn when a
  // custom-period (non-weekly-keyed) invoice already covers this site+week.
  // We still upsert the weekly draft — the ids are returned so the route
  // can surface a warning, and logged so the auto-sync (approval) path
  // leaves a trace even though it has no UI.
  const overlappingInvoiceIds = await findWeeklyOverlapInvoiceIds(siteId, weekStartIso, periodEnd);
  if (overlappingInvoiceIds.length > 0) {
    logger.warn(
      { siteId, weekStartIso, overlappingInvoiceIds },
      "[invoice-sync] weekly invoice overlaps existing custom-period invoice(s) — possible double-billing",
    );
  }

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
        taxAmount: "0",
        totalAmount: String(total),
        processingFeeRate: feeEnabled ? String(feeRate) : null,
        processingFeeAmount: feeEnabled ? String(feeAmount) : null,
      })
      .where(eq(invoicesTable.id, existing.id))
      .returning();
    return {
      status: "updated",
      invoiceId: updated.id,
      totalAmount: total,
      lineCount: lineItems.length,
      overlappingInvoiceIds,
      ...(unpriced > 0 ? { unpricedHours: unpriced } : {}),
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
        taxAmount: "0",
        totalAmount: String(total),
        processingFeeRate: feeEnabled ? String(feeRate) : null,
        processingFeeAmount: feeEnabled ? String(feeAmount) : null,
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
      overlappingInvoiceIds,
      ...(unpriced > 0 ? { unpricedHours: unpriced } : {}),
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
    // Use the same unified fee logic as the non-race path.
    const rwFeeEnabled = isProcessingFeeEnabled() && !!site.salesTaxEnabled;
    const rwFeeRate = rwFeeEnabled ? parseFloat(String(site.salesTaxRate ?? "8.25")) : 0;
    const rwFeeAmount = rwFeeEnabled ? Math.round(subtotal * rwFeeRate / 100 * 100) / 100 : 0;
    const rwTotal = Math.round((subtotal + rwFeeAmount) * 100) / 100;
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
        taxAmount: "0",
        totalAmount: String(rwTotal),
        processingFeeRate: rwFeeEnabled ? String(rwFeeRate) : null,
        processingFeeAmount: rwFeeEnabled ? String(rwFeeAmount) : null,
      })
      .where(eq(invoicesTable.id, raceWinner.id));
    return {
      status: "updated",
      invoiceId: raceWinner.id,
      totalAmount: rwTotal,
      lineCount: lineItems.length,
      overlappingInvoiceIds,
      ...(unpriced > 0 ? { unpricedHours: unpriced } : {}),
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
    const weekStart = weekStartIsoBusiness(clockIn);
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
    const weekStart = weekStartIsoBusiness(clockIn);
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
 * Generate a custom-period invoice for (siteId, periodStart, periodEnd).
 *
 * Unlike the weekly path this function:
 *  - Does NOT check billingCycle — it's the admin's explicit override.
 *  - Always creates a NEW draft (never updates an existing one) so the
 *    admin can re-run for the same period if they want an adjustment draft.
 *  - Sets autoSynced = false so the scheduler never touches this row.
 *  - Does NOT handle concurrent-insert races — autoSynced=false rows are
 *    excluded from the partial unique index so there's no constraint to hit.
 */
export async function upsertCustomPeriodInvoice(
  siteId: string,
  periodStartIso: string,
  periodEndIso: string,
): Promise<UpsertResult> {
  // Interpret both boundaries as BUSINESS-TIMEZONE calendar days (PAYROLL_TIMEZONE,
  // default America/Chicago) — not UTC midnight. Admins pick calendar dates and see
  // entries rendered in business time everywhere else; UTC-midnight boundaries would
  // misfile evening entries (after ~7pm Central) into the neighbouring day.
  const rawStart = new Date(`${periodStartIso}T00:00:00.000Z`);
  const rawEnd = new Date(`${periodEndIso}T00:00:00.000Z`);
  if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
    return { status: "skipped", reason: "invalid periodStart or periodEnd" };
  }
  const tz = businessTimeZone();
  const start = businessDateToUtc(periodStartIso, tz);
  // Exclusive upper bound: entries with clockIn on periodEnd are included.
  const end = businessDateToUtc(isoDate(addDaysUtc(rawEnd, 1)), tz);
  if (end <= start) {
    return { status: "skipped", reason: "periodEnd must be after periodStart" };
  }

  const [site] = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      clientId: sitesTable.clientId,
      defaultBillRate: sitesTable.defaultBillRate,
      salesTaxEnabled: sitesTable.salesTaxEnabled,
      salesTaxRate: sitesTable.salesTaxRate,
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

  // Pull every approved entry for this site+period, grouped by officer+rate.
  const entries = await db
    .select({
      hoursWorked: timeEntriesTable.hoursWorked,
      clockInTime: timeEntriesTable.clockInTime,
      shiftBillRate: shiftsTable.billRate,
      shiftLevel: shiftsTable.requiredLicenseLevel,
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

  type Group = { description: string; level: number | null; hours: number; rate: number; amount: number };
  const groups = new Map<string, Group>();
  // Approved hours we could NOT price (no shift bill rate AND no site default
  // bill rate). These must be surfaced to the admin — silently dropping them
  // produces an invoice that under-bills with no visible sign anything is wrong.
  let unpricedHours = 0;
  for (const e of entries) {
    const hours = parseFloat(String(e.hoursWorked ?? "0"));
    if (!isFinite(hours) || hours <= 0) continue;
    const shiftBill = parseFloat(String(e.shiftBillRate ?? "0"));
    const baseRate = shiftBill > 0 ? shiftBill : siteBillRate;
    if (baseRate <= 0) { unpricedHours += hours; continue; }
    const officerName =
      [e.employeeFirst, e.employeeLast].filter(Boolean).join(" ") || "Unassigned officer";
    const level = e.shiftLevel ?? null;
    const holidayName = getFederalHolidayName(e.clockInTime);
    const rate = holidayName ? Math.round(baseRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100 : baseRate;
    const description = holidayName
      ? `${officerName} — Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : officerName;
    const key = `${officerName}__${level ?? ""}__${rate}__${holidayName ?? ""}`;
    const cur = groups.get(key) ?? { description, level, hours: 0, rate, amount: 0 };
    cur.hours += hours;
    cur.amount += hours * rate;
    groups.set(key, cur);
  }

  // Subcontractor hours for this period.
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
    if (siteBillRate <= 0) { unpricedHours += hours; continue; }
    const holidayName = getFederalHolidayName(e.clockInAt);
    const rate = holidayName ? Math.round(siteBillRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100 : siteBillRate;
    const label = holidayName
      ? `${e.name} (${e.company}) — subcontractor, Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : `${e.name} (${e.company}) — subcontractor`;
    const key = `sub__${label}__${rate}`;
    const cur = groups.get(key) ?? { description: label, level: null, hours: 0, rate, amount: 0 };
    cur.hours += hours;
    cur.amount += hours * rate;
    groups.set(key, cur);
  }

  const lineItems = Array.from(groups.values())
    .sort((a, b) => a.description.localeCompare(b.description))
    .map((g) => ({
      description: g.description,
      level: g.level,
      hours: Math.round(g.hours * 100) / 100,
      rate: g.rate,
      amount: Math.round(g.amount * 100) / 100,
    }));

  if (lineItems.length === 0) {
    return { status: "skipped", reason: "no priced entries" };
  }

  const subtotal = Math.round(lineItems.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  // Unified fee: platform master switch AND per-site salesTaxEnabled, rate from site.
  const cpFeeEnabled = isProcessingFeeEnabled() && !!site.salesTaxEnabled;
  const cpFeeRate = cpFeeEnabled ? parseFloat(String(site.salesTaxRate ?? "8.25")) : 0;
  const cpFeeAmount = cpFeeEnabled ? Math.round(subtotal * cpFeeRate / 100 * 100) / 100 : 0;
  const total = Math.round((subtotal + cpFeeAmount) * 100) / 100;
  const dueDate = isoDate(addDaysUtc(new Date(), client.paymentTermsDays ?? 30));

  const [created] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: generateInvoiceNumber(),
      clientId: client.id,
      siteId: site.id,
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
      clientName: client.name,
      clientEmail: client.contactEmail,
      clientAddress: client.billingAddress,
      lineItems,
      subtotal: String(subtotal),
      taxAmount: "0",
      totalAmount: String(total),
      processingFeeRate: cpFeeEnabled ? String(cpFeeRate) : null,
      processingFeeAmount: cpFeeEnabled ? String(cpFeeAmount) : null,
      status: "draft",
      dueDate,
      notes: `${site.name} — ${periodStartIso} to ${periodEndIso}`,
      autoSynced: false,
    })
    .returning();

  return {
    status: "created",
    invoiceId: created.id,
    totalAmount: total,
    lineCount: lineItems.length,
    ...(unpricedHours > 0 ? { unpricedHours: Math.round(unpricedHours * 100) / 100 } : {}),
  };
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
