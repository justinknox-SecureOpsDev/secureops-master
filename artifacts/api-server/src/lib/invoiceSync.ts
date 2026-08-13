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
  subcontractorQrTokensTable,
  type TimeEntry,
  type SubcontractorTimeEntry,
} from "@workspace/db";
import { logger } from "./logger";
import { getFederalHolidayName, HOLIDAY_PAY_MULTIPLIER } from "./holidays";
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

/**
 * One individual work session (officer or subcontractor clock-in/out) inside
 * an invoice period, carrying everything the generators need to roll it into
 * a line item AND everything the Invoice Board drill-down needs to display it.
 *
 * This is the single source of truth for "what was billed": both invoice
 * generators build their line items from these entries via
 * buildLineItemsFromEntries(), and the read-only
 * GET /invoices/:id/entries endpoint returns the same entries, so the
 * displayed sessions can never drift from the billing math.
 */
export type InvoicePeriodEntry = {
  kind: "officer" | "subcontractor";
  entryId: string;
  /** Officer full name, or "Name (Company)" for subcontractors. */
  workerName: string;
  clockIn: Date;
  clockOut: Date | null;
  /** Parsed hoursWorked; 0 when missing/invalid/still open. */
  hours: number;
  level: number | null;
  holidayName: string | null;
  /** Resolved bill rate incl. holiday premium; null when no rate applies. */
  rate: number | null;
  /** hours > 0 but no bill rate could be resolved — dropped from billing. */
  unpriced: boolean;
  /** hours > 0 AND a rate resolved — contributes to a line item. */
  billable: boolean;
  /** Line-item grouping key (null when not billable). */
  groupKey: string | null;
  /** The line-item description this entry rolls into. */
  description: string;
};

/**
 * Collect every approved officer entry + closed subcontractor entry for
 * (siteId, [start, end)) with its resolved rate, holiday premium, unpriced
 * flag, and line-item group key. Pure read — shared by both invoice
 * generators and the invoice drill-down endpoint.
 */
export async function collectInvoicePeriodEntries(
  siteId: string,
  start: Date,
  end: Date,
  siteBillRate: number,
): Promise<InvoicePeriodEntry[]> {
  const out: InvoicePeriodEntry[] = [];

  // Approved officer entries for this site+period.
  const entries = await db
    .select({
      id: timeEntriesTable.id,
      hoursWorked: timeEntriesTable.hoursWorked,
      clockInTime: timeEntriesTable.clockInTime,
      clockOutTime: timeEntriesTable.clockOutTime,
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
  for (const e of entries) {
    const hoursRaw = parseFloat(String(e.hoursWorked ?? "0"));
    const hours = isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 0;
    const shiftBill = parseFloat(String(e.shiftBillRate ?? "0"));
    const baseRate = shiftBill > 0 ? shiftBill : siteBillRate;
    const officerName =
      [e.employeeFirst, e.employeeLast].filter(Boolean).join(" ") || "Unassigned officer";
    const level = e.shiftLevel ?? null;
    // Federal-holiday premium (1.5×): hours worked on a US federal holiday
    // (clock-in date in PAYROLL_TIMEZONE) are billed at time-and-a-half and
    // split into their own line item so the client sees the premium plainly.
    const holidayName = getFederalHolidayName(e.clockInTime);
    const rate =
      baseRate > 0
        ? holidayName
          ? Math.round(baseRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100
          : baseRate
        : null;
    const description = holidayName
      ? `${officerName} — Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : officerName;
    const billable = hours > 0 && rate !== null;
    out.push({
      kind: "officer",
      entryId: e.id,
      workerName: officerName,
      clockIn: e.clockInTime,
      clockOut: e.clockOutTime ?? null,
      hours,
      level,
      holidayName,
      rate,
      unpriced: hours > 0 && rate === null,
      billable,
      groupKey: billable ? `${officerName}__${level ?? ""}__${rate}__${holidayName ?? ""}` : null,
      description,
    });
  }

  // Subcontractor hours. Closed entries only (clockOutAt set) for this
  // site+period. Bill rate priority: (1) explicit billRate on the QR token
  // that was used at clock-in, (2) site's defaultBillRate. The same 1.5×
  // holiday premium applies to whichever rate is chosen.
  const subEntries = await db
    .select({
      id: subcontractorTimeEntriesTable.id,
      hoursWorked: subcontractorTimeEntriesTable.hoursWorked,
      clockInAt: subcontractorTimeEntriesTable.clockInAt,
      clockOutAt: subcontractorTimeEntriesTable.clockOutAt,
      name: subcontractorTimeEntriesTable.name,
      company: subcontractorTimeEntriesTable.company,
      // QR token's explicit bill rate — takes precedence over site default.
      qrBillRate: subcontractorQrTokensTable.billRate,
    })
    .from(subcontractorTimeEntriesTable)
    .leftJoin(
      subcontractorQrTokensTable,
      eq(subcontractorTimeEntriesTable.qrTokenId, subcontractorQrTokensTable.id),
    )
    .where(
      and(
        eq(subcontractorTimeEntriesTable.siteId, siteId),
        isNotNull(subcontractorTimeEntriesTable.clockOutAt),
        gte(subcontractorTimeEntriesTable.clockInAt, start),
        lt(subcontractorTimeEntriesTable.clockInAt, end),
      ),
    );
  for (const e of subEntries) {
    const hoursRaw = parseFloat(String(e.hoursWorked ?? "0"));
    const hours = isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 0;
    const holidayName = getFederalHolidayName(e.clockInAt);
    // Resolve effective bill rate: QR-token rate → site default → null (unpriced).
    const qrRate = e.qrBillRate != null ? parseFloat(String(e.qrBillRate)) : NaN;
    const effectiveBillRate = isFinite(qrRate) && qrRate > 0 ? qrRate : siteBillRate;
    const rate =
      effectiveBillRate > 0
        ? holidayName
          ? Math.round(effectiveBillRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100
          : effectiveBillRate
        : null;
    const label = holidayName
      ? `${e.name} (${e.company}) — subcontractor, Holiday (${holidayName}, ${HOLIDAY_PAY_MULTIPLIER}×)`
      : `${e.name} (${e.company}) — subcontractor`;
    const billable = hours > 0 && rate !== null;
    out.push({
      kind: "subcontractor",
      entryId: e.id,
      workerName: `${e.name} (${e.company})`,
      clockIn: e.clockInAt,
      clockOut: e.clockOutAt ?? null,
      hours,
      level: null,
      holidayName,
      rate,
      unpriced: hours > 0 && rate === null,
      billable,
      groupKey: billable ? `sub__${label}__${rate}` : null,
      description: label,
    });
  }

  return out;
}

/**
 * Roll individual period entries into invoice line items, exactly as both
 * generators have always done: group by (worker, level, rate, holiday),
 * accumulate hours × rate, round once per line, sort by description.
 * Approved hours with no resolvable rate accumulate into unpricedHours —
 * silently dropping them produces an invoice that under-bills with no
 * visible sign anything is wrong.
 */
export function buildLineItemsFromEntries(entries: InvoicePeriodEntry[]): {
  lineItems: Array<{ description: string; level: number | null; hours: number; rate: number; amount: number }>;
  unpricedHours: number;
} {
  type Group = { description: string; level: number | null; hours: number; rate: number; amount: number };
  const groups = new Map<string, Group>();
  let unpricedHours = 0;
  for (const e of entries) {
    if (e.hours <= 0) continue;
    if (!e.billable || e.rate === null || !e.groupKey) {
      unpricedHours += e.hours;
      continue;
    }
    const cur = groups.get(e.groupKey) ?? { description: e.description, level: e.level, hours: 0, rate: e.rate, amount: 0 };
    cur.hours += e.hours;
    cur.amount += e.hours * e.rate;
    groups.set(e.groupKey, cur);
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
  return { lineItems, unpricedHours };
}

/**
 * The exact [start, end) UTC window of entries covered by an invoice with
 * business-TZ calendar-day boundaries periodStart..periodEnd (inclusive).
 * Matches both generators: the custom-period path uses this formula
 * directly, and for weekly invoices (periodEnd = periodStart + 6 days)
 * businessDateToUtc(periodEnd + 1 day) IS the next business-week Monday
 * midnight the weekly path computes via startOfBusinessWeek (DST-safe,
 * since businessDateToUtc resolves the actual local midnight).
 */
export function invoicePeriodWindow(periodStartIso: string, periodEndIso: string): { start: Date; end: Date } | null {
  const rawEnd = new Date(`${periodEndIso}T00:00:00.000Z`);
  const tz = businessTimeZone();
  const start = businessDateToUtc(periodStartIso, tz);
  if (Number.isNaN(start.getTime()) || Number.isNaN(rawEnd.getTime())) return null;
  const end = businessDateToUtc(isoDate(addDaysUtc(rawEnd, 1)), tz);
  if (end <= start) return null;
  return { start, end };
}

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

/**
 * Generate the next invoice number for the current calendar month, using a
 * max+1 strategy within the month to avoid random collisions.
 *
 * The format is INV-YYYYMM-NNNN (e.g. INV-202608-0042).  Two concurrent
 * callers can still race and read the same max, so callers must catch a
 * 23505 on "invoices_invoice_number_unique" and retry — see the insert
 * wrappers below.
 */
export async function generateInvoiceNumber(): Promise<string> {
  const now = new Date();
  const prefix = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  // Cast to integer before max() so that 10000 > 9999 (text ordering would
  // incorrectly put '9999' > '10000').
  //
  // Implementation notes:
  //   • The substring start position is inlined via sql.raw() as a literal
  //     integer (it is a JS constant, not user input) because PostgreSQL's
  //     SUBSTRING(str FROM pos) form does not accept a parameterised $N for
  //     `pos` in all driver/protocol combinations — using a placeholder here
  //     causes Drizzle to emit $N where PG expects a literal, returning NULL.
  //   • A CASE expression skips rows whose suffix is non-numeric without
  //     raising a cast error; MAX() ignores NULLs automatically.
  const suffixStart = sql.raw(String(prefix.length + 2)); // 1-indexed position after the last '-'
  const [row] = await db
    .select({
      maxSuffix: sql<number | null>`max(
        case when substring(invoice_number from ${suffixStart}) ~ '^[0-9]+$'
             then cast(substring(invoice_number from ${suffixStart}) as integer)
        end
      )`,
    })
    .from(invoicesTable)
    .where(sql`invoice_number like ${prefix + "-%"}`);
  const next = (row?.maxSuffix ?? 0) + 1;
  // Left-pad to at least 4 digits; naturally grows beyond 9999 without wrapping.
  return `${prefix}-${String(next).padStart(4, "0")}`;
}

/** True when `err` is a unique-key violation on the invoice_number column.
 *
 * Drizzle wraps PG driver errors in DrizzleQueryError; the PG-specific fields
 * (code, constraint) are on err.cause, not on err itself.  We check both
 * levels for compatibility with any future change in Drizzle's error shape.
 */
function isInvoiceNumberCollision(err: unknown): boolean {
  type PgFields = { code?: string; constraint?: string };
  const e = err as (PgFields & { cause?: PgFields }) | null;
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return code === "23505" && constraint === "invoices_invoice_number_unique";
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
      processingFeeEnabled: sitesTable.processingFeeEnabled,
      processingFeeRate: sitesTable.processingFeeRate,
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

  // Pull every approved officer entry + closed subcontractor entry for this
  // site+week and roll them into line items via the SHARED helpers — the
  // same entries the Invoice Board drill-down endpoint returns, so the
  // displayed sessions can never drift from what was billed. Approved hours
  // with no resolvable rate accumulate into unpricedHours (mirrors the
  // custom-period path); if that leaves the whole week with zero priced
  // lines the upsert refuses with "no priced entries" (surfaced as the
  // explicit 400 by the route).
  const periodEntries = await collectInvoicePeriodEntries(siteId, start, end, siteBillRate);
  const { lineItems, unpricedHours } = buildLineItemsFromEntries(periodEntries);

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
  // Each site owns its fee toggle and rate. taxAmount is zeroed; the
  // processingFeeAmount column is the canonical fee snapshot on invoices.
  const feeEnabled = !!site.processingFeeEnabled;
  const feeRate = feeEnabled ? parseFloat(String(site.processingFeeRate ?? "8.25")) : 0;
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
  // Retry up to 5 times in the rare event two concurrent inserts race on the
  // same generated invoice number (23505 on invoices_invoice_number_unique).
  // Each retry re-queries the max so the new candidate is always max+1 at
  // that moment.  A 23505 on the DRAFT partial index (two concurrent approvals
  // racing to create the same site+week draft) is handled separately below.
  let lastInsertErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [created] = await db
        .insert(invoicesTable)
        .values({
          invoiceNumber: await generateInvoiceNumber(),
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
      if (isInvoiceNumberCollision(err)) {
        lastInsertErr = err;
        continue; // regenerate number and retry
      }
      // Not an invoice-number collision — fall through to draft-index handler.
      lastInsertErr = err;
      break;
    }
  }
  {
    const err = lastInsertErr;
    // Concurrent approval beat us to the insert. The partial unique
    // index `invoices_active_auto_draft_per_week_idx` guarantees only
    // one active-sync draft exists; re-select it and apply our totals
    // as an UPDATE so the latest-arriving tick wins (idempotent).
    // Drizzle wraps PG errors: code lives on err.cause, not err directly.
    type PgFields = { code?: string };
    const e = err as (PgFields & { cause?: PgFields }) | null;
    const code = e?.code ?? e?.cause?.code;
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
    // Use the same site-level fee logic as the non-race path.
    const rwFeeEnabled = !!site.processingFeeEnabled;
    const rwFeeRate = rwFeeEnabled ? parseFloat(String(site.processingFeeRate ?? "8.25")) : 0;
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
      processingFeeEnabled: sitesTable.processingFeeEnabled,
      processingFeeRate: sitesTable.processingFeeRate,
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

  // Pull every approved officer entry + closed subcontractor entry for this
  // site+period and roll them into line items via the SHARED helpers — the
  // same entries the Invoice Board drill-down endpoint returns. Approved
  // hours with no resolvable rate accumulate into unpricedHours: these must
  // be surfaced to the admin — silently dropping them produces an invoice
  // that under-bills with no visible sign anything is wrong.
  const periodEntries = await collectInvoicePeriodEntries(siteId, start, end, siteBillRate);
  const { lineItems, unpricedHours } = buildLineItemsFromEntries(periodEntries);

  if (lineItems.length === 0) {
    return { status: "skipped", reason: "no priced entries" };
  }

  const subtotal = Math.round(lineItems.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  // The site is the sole owner of its processing-fee setting and rate.
  const cpFeeEnabled = !!site.processingFeeEnabled;
  const cpFeeRate = cpFeeEnabled ? parseFloat(String(site.processingFeeRate ?? "8.25")) : 0;
  const cpFeeAmount = cpFeeEnabled ? Math.round(subtotal * cpFeeRate / 100 * 100) / 100 : 0;
  const total = Math.round((subtotal + cpFeeAmount) * 100) / 100;
  const dueDate = isoDate(addDaysUtc(new Date(), client.paymentTermsDays ?? 30));

  // Retry up to 5 times on invoice_number collisions (two concurrent inserts
  // reading the same max simultaneously).
  let created: typeof invoicesTable.$inferSelect | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      [created] = await db
        .insert(invoicesTable)
        .values({
          invoiceNumber: await generateInvoiceNumber(),
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
      break;
    } catch (err) {
      if (isInvoiceNumberCollision(err) && attempt < 4) continue;
      throw err;
    }
  }
  if (!created) throw new Error("[invoice-sync] custom period insert failed after retries");

  return {
    status: "created",
    invoiceId: created.id,
    totalAmount: total,
    lineCount: lineItems.length,
    ...(unpricedHours > 0 ? { unpricedHours: Math.round(unpricedHours * 100) / 100 } : {}),
  };
}

/**
 * Re-sync every open auto-synced draft invoice for a site.
 *
 * Called after a site's fee settings (processingFeeEnabled /
 * processingFeeRate) change
 * so that existing draft invoices immediately reflect the new fee without
 * requiring an admin to regenerate them by hand.
 *
 * Only touches rows that are still "syncable" (draft + unlocked + autoSynced).
 * Manually-edited drafts are left alone (they are excluded by autoSynced=true
 * filter inside upsertWeeklyInvoice). Never throws — best-effort; failures
 * are logged.
 */
export async function resyncSiteAutoSyncedDrafts(siteId: string): Promise<void> {
  try {
    // Find every open auto-synced draft for this site.
    const openDrafts = await db
      .select({ id: invoicesTable.id, periodStart: invoicesTable.periodStart })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.siteId, siteId),
          eq(invoicesTable.status, SYNCABLE_STATUS),
          isNull(invoicesTable.lockedAt),
          eq(invoicesTable.autoSynced, true),
          isNotNull(invoicesTable.periodStart),
        ),
      );

    if (openDrafts.length === 0) return;

    logger.info(
      { siteId, count: openDrafts.length },
      "[invoice-sync] re-syncing open auto-synced drafts after fee-setting change",
    );

    for (const draft of openDrafts) {
      if (!draft.periodStart) continue;
      try {
        const result = await upsertWeeklyInvoice(siteId, draft.periodStart);
        if (result.status === "updated" || result.status === "created") {
          logger.info(
            { siteId, weekStart: draft.periodStart, invoiceId: result.invoiceId, total: result.totalAmount },
            "[invoice-sync] draft invoice re-synced after fee-setting change",
          );
        } else {
          logger.debug(
            { siteId, weekStart: draft.periodStart, result },
            "[invoice-sync] draft invoice re-sync skipped/deleted",
          );
        }
      } catch (err) {
        logger.warn({ err, siteId, invoiceId: draft.id }, "[invoice-sync] re-sync of single draft failed");
      }
    }
  } catch (err) {
    logger.warn({ err, siteId }, "[invoice-sync] resyncSiteAutoSyncedDrafts failed");
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
