import { Router, type IRouter, type Request, type Response } from "express";
import { sql, and, gte, lte, eq, lt, inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  db,
  invoicesTable,
  payrollEntriesTable,
  timeEntriesTable,
  shiftsTable,
  shiftAssignmentsTable,
  incidentsTable,
  sitesTable,
  clientsTable,
  usersTable,
  employeesTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { businessTimeZone } from "../lib/businessTime";
import { buildAnalyticsReportPdf } from "../lib/analyticsPdf";
import { brand } from "../lib/brandConfig";

const router: IRouter = Router();

/**
 * Converts an ISO date string (YYYY-MM-DD) into a UTC timestamp that
 * represents midnight in the business timezone on that date.
 */
function dateToBusinessTzStart(dateStr: string, tz: string): Date {
  // Parse the local date in the business TZ and convert to UTC instant.
  const [year, month, day] = dateStr.split("-").map(Number);
  // Build midnight in the target TZ using Intl reverse-offset trick.
  const naive = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offset = getUtcOffsetMs(naive, tz);
  return new Date(naive.getTime() - offset);
}

function getUtcOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const hour = m.hour === 24 ? 0 : m.hour;
  const asUtc = Date.UTC(m.year, m.month - 1, m.day, hour, m.minute, m.second);
  return asUtc - date.getTime();
}

/** Get the ISO week label (YYYY-Www) for a Date in the business timezone */
function weekBucket(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  const d = new Date(Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day)));
  // ISO week: find Monday of the week
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const monday = new Date(d.getTime() - dayOfWeek * 86400_000);
  return `${monday.getUTCFullYear()}-W${String(isoWeek(monday)).padStart(2, "0")}`;
}

function isoWeek(monday: Date): number {
  const jan4 = new Date(Date.UTC(monday.getUTCFullYear(), 0, 4));
  const startOfYear = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400_000);
  return Math.round((monday.getTime() - startOfYear.getTime()) / (7 * 86400_000)) + 1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ISO week label (YYYY-Www) for a plain calendar date string ("YYYY-MM-DD").
 * Invoice/payroll periodStart columns are date-only values already expressed in
 * the business calendar — bucket them by that calendar date directly. Do NOT
 * parse them as UTC midnight and re-render in the business timezone: UTC
 * midnight Monday is Sunday evening in Central, which shifts the whole week's
 * revenue/labor into the previous ISO week and misaligns it with the
 * SQL-side (date_trunc AT TIME ZONE) hour buckets.
 */
function weekBucketForDateOnly(dateStr: string): string {
  const [y, mo, da] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1, da));
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const monday = new Date(d.getTime() - dayOfWeek * 86400_000);
  return `${monday.getUTCFullYear()}-W${String(isoWeek(monday)).padStart(2, "0")}`;
}

/**
 * Validate the `start` / `end` / optional `clientId` query params shared by
 * the summary and both export routes. Writes the 400 response itself and
 * returns null on failure.
 */
function parseRange(
  req: Request,
  res: Response,
): { start: string; end: string; clientId?: string } | null {
  const { start, end, clientId } = req.query as {
    start?: string;
    end?: string;
    clientId?: string;
  };
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    res.status(400).json({ error: "start and end are required in YYYY-MM-DD format" });
    return null;
  }
  if (clientId !== undefined && clientId !== "") {
    if (typeof clientId !== "string" || !UUID_RE.test(clientId)) {
      res.status(400).json({ error: "clientId must be a valid UUID" });
      return null;
    }
    return { start, end, clientId };
  }
  return { start, end };
}

/**
 * Resolve the client row for an optional clientId filter. Writes the 404
 * response itself and returns undefined on failure; returns null when no
 * filter was requested.
 */
async function resolveClientFilter(
  clientId: string | undefined,
  res: Response,
): Promise<{ id: string; name: string } | null | undefined> {
  if (!clientId) return null;
  const [client] = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return undefined;
  }
  return client;
}

export type AnalyticsSummaryData = Awaited<ReturnType<typeof computeAnalyticsSummary>>;

/**
 * Compute the full analytics summary (P&L, hours, missed shifts, incidents,
 * trends, per-site breakdown) for an inclusive [start, end] date range.
 * Shared by the JSON summary route and the CSV / PDF export routes so all
 * three surfaces always agree on the numbers.
 *
 * When `clientId` is provided, every metric is restricted to sites belonging
 * to that client (a client with no sites yields an all-zero summary).
 */
export async function computeAnalyticsSummary(start: string, end: string, clientId?: string) {
  // Optional client scoping: resolve the client's site ids once, then apply
  // the same site filter to every query below so all sections agree.
  let clientSiteIds: string[] | null = null;
  if (clientId) {
    const siteRows = await db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.clientId, clientId));
    clientSiteIds = siteRows.map((r) => r.id);
  }
  /** Site-scoping condition for a siteId column; undefined = no filter. */
  const siteFilter = (col: PgColumn): SQL | undefined => {
    if (clientSiteIds === null) return undefined;
    if (clientSiteIds.length === 0) return sql`false`;
    return inArray(col, clientSiteIds);
  };

  const tz = businessTimeZone();
  const startUtc = dateToBusinessTzStart(start, tz);
  // End date is inclusive — use start of the *next* day
  const [ey, em, ed] = end.split("-").map(Number);
  const endExclusive = dateToBusinessTzStart(
    `${ey}-${String(em).padStart(2, "0")}-${String(ed + 1).padStart(2, "0")}`,
    tz,
  );
  const now = new Date();

  // ── 1. Revenue: sum of invoice totalAmount for invoices with periodStart in range ──
  const [rev] = await db
    .select({ total: sql<number>`coalesce(sum(${invoicesTable.totalAmount}::numeric), 0)::float` })
    .from(invoicesTable)
    .where(
      and(
        gte(invoicesTable.periodStart, start),
        lte(invoicesTable.periodStart, end),
        siteFilter(invoicesTable.siteId),
      ),
    );

  // ── 2. Labor cost: sum of grossPay for payroll entries with periodStart in range ──
  const [labor] = await db
    .select({ total: sql<number>`coalesce(sum(${payrollEntriesTable.grossPay}::numeric), 0)::float` })
    .from(payrollEntriesTable)
    .where(
      and(
        gte(payrollEntriesTable.periodStart, start),
        lte(payrollEntriesTable.periodStart, end),
        siteFilter(payrollEntriesTable.siteId),
      ),
    );

  const revenue = rev?.total ?? 0;
  const laborCost = labor?.total ?? 0;
  const profit = revenue - laborCost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  // ── 3. Hours worked (approved time entries with clockInTime in range) ──
  const [workedRow] = await db
    .select({ total: sql<number>`coalesce(sum(${timeEntriesTable.hoursWorked}::numeric), 0)::float` })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.approvalStatus, "approved"),
        gte(timeEntriesTable.clockInTime, startUtc),
        lt(timeEntriesTable.clockInTime, endExclusive),
        siteFilter(timeEntriesTable.siteId),
      ),
    );
  const hoursWorked = workedRow?.total ?? 0;

  // ── 4. Hours scheduled (past shifts where endTime is in range) ──
  // Hours scheduled = sum of (endTime - startTime) * headcount for each shift.
  const [scheduledRow] = await db
    .select({
      total: sql<number>`coalesce(
        sum(
          extract(epoch from ${shiftsTable.endTime} - ${shiftsTable.startTime}) / 3600.0
          * ${shiftsTable.headcount}
        ), 0
      )::float`,
    })
    .from(shiftsTable)
    .where(
      and(
        gte(shiftsTable.endTime, startUtc),
        lt(shiftsTable.endTime, endExclusive),
        lt(shiftsTable.endTime, now),
        siteFilter(shiftsTable.siteId),
      ),
    );
  const hoursScheduled = scheduledRow?.total ?? 0;
  const coveragePct = hoursScheduled > 0 ? Math.min(100, (hoursWorked / hoursScheduled) * 100) : 0;

  // ── 5. Missed shifts: past shifts with accepted assignments that have no time entry ──
  // We run two queries to avoid complex correlated subqueries:
  // a) Past shifts with accepted assignment counts and time-entry counts per (shift, employee)
  const pastShiftsRaw = await db
    .select({
      shiftId: shiftsTable.id,
      title: shiftsTable.title,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      siteId: shiftsTable.siteId,
      siteName: sitesTable.name,
      headcount: shiftsTable.headcount,
      filled: sql<number>`count(${shiftAssignmentsTable.id}) filter (where ${shiftAssignmentsTable.status} = 'accepted')::int`,
      noShows: sql<number>`count(${shiftAssignmentsTable.id}) filter (
        where ${shiftAssignmentsTable.status} = 'accepted'
        and not exists (
          select 1 from time_entries te
          where te.employee_id = ${shiftAssignmentsTable.employeeId}
            and te.shift_id = ${shiftsTable.id}
        )
      )::int`,
    })
    .from(shiftsTable)
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .leftJoin(shiftAssignmentsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .where(
      and(
        gte(shiftsTable.endTime, startUtc),
        lt(shiftsTable.endTime, endExclusive),
        lt(shiftsTable.endTime, now),
        siteFilter(shiftsTable.siteId),
      ),
    )
    .groupBy(shiftsTable.id, sitesTable.name);

  const noShowCount = pastShiftsRaw.reduce((s, r) => s + (r.noShows ?? 0), 0);
  const unfilledCount = pastShiftsRaw.filter((r) => (r.filled ?? 0) < r.headcount).length;

  const missedShifts = pastShiftsRaw
    .filter((r) => (r.noShows ?? 0) > 0 || (r.filled ?? 0) < r.headcount)
    .slice(0, 100)
    .map((r) => ({
      shiftId: r.shiftId,
      title: r.title,
      startTime: r.startTime instanceof Date ? r.startTime.toISOString() : String(r.startTime),
      endTime: r.endTime instanceof Date ? r.endTime.toISOString() : String(r.endTime),
      siteId: r.siteId,
      siteName: r.siteName ?? null,
      headcount: r.headcount,
      filled: r.filled ?? 0,
      noShows: r.noShows ?? 0,
    }));

  // ── 6. Incident metrics ──
  // Incidents don't link to a site directly — when a client filter is on,
  // scope through the incident's shift (left join keeps count parity when
  // unfiltered; shiftless incidents are excluded by the filter, matching the
  // per-site incident attribution below).
  const incidentRows = await db
    .select({
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      occurredAt: incidentsTable.occurredAt,
      siteId: sql<string | null>`null`, // incidents don't link to site directly
    })
    .from(incidentsTable)
    .leftJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .where(
      and(
        gte(incidentsTable.occurredAt, startUtc),
        lt(incidentsTable.occurredAt, endExclusive),
        siteFilter(shiftsTable.siteId),
      ),
    );

  const incidentTotal = incidentRows.length;
  const incidentsBySeverity = { low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>;
  const incidentsByStatus = { open: 0, investigating: 0, closed: 0 } as Record<string, number>;
  for (const inc of incidentRows) {
    const sev = inc.severity ?? "low";
    if (sev in incidentsBySeverity) incidentsBySeverity[sev]++;
    const st = inc.status ?? "open";
    if (st in incidentsByStatus) incidentsByStatus[st]++;
  }

  // ── 7. Trend series (weekly buckets) ──
  // Revenue trend: per invoice periodStart week
  const invoiceTrendRows = await db
    .select({
      periodStart: invoicesTable.periodStart,
      total: sql<number>`coalesce(sum(${invoicesTable.totalAmount}::numeric), 0)::float`,
    })
    .from(invoicesTable)
    .where(
      and(
        gte(invoicesTable.periodStart, start),
        lte(invoicesTable.periodStart, end),
        siteFilter(invoicesTable.siteId),
      ),
    )
    .groupBy(invoicesTable.periodStart);

  // Labor trend: per payroll entry periodStart week
  const laborTrendRows = await db
    .select({
      periodStart: payrollEntriesTable.periodStart,
      total: sql<number>`coalesce(sum(${payrollEntriesTable.grossPay}::numeric), 0)::float`,
    })
    .from(payrollEntriesTable)
    .where(
      and(
        gte(payrollEntriesTable.periodStart, start),
        lte(payrollEntriesTable.periodStart, end),
        siteFilter(payrollEntriesTable.siteId),
      ),
    )
    .groupBy(payrollEntriesTable.periodStart);

  // Build week-keyed maps
  const revByWeek = new Map<string, number>();
  for (const r of invoiceTrendRows) {
    const wk = weekBucketForDateOnly(r.periodStart as string);
    revByWeek.set(wk, (revByWeek.get(wk) ?? 0) + r.total);
  }
  const laborByWeek = new Map<string, number>();
  for (const r of laborTrendRows) {
    const wk = weekBucketForDateOnly(r.periodStart as string);
    laborByWeek.set(wk, (laborByWeek.get(wk) ?? 0) + r.total);
  }

  // Hours trend: grouped by business-timezone week start.
  // Inline tz as a SQL literal (not a parameter) so SELECT and GROUP BY produce
  // the exact same expression text, which PostgreSQL requires for GROUP BY matching.
  const tzLit = sql.raw(`'${tz.replace(/'/g, "''")}'`);
  const hoursWorkedTrendRows = await db
    .select({
      weekStart: sql<string>`date_trunc('week', ${timeEntriesTable.clockInTime} AT TIME ZONE ${tzLit})::text`,
      hours: sql<number>`coalesce(sum(${timeEntriesTable.hoursWorked}::numeric), 0)::float`,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.approvalStatus, "approved"),
        gte(timeEntriesTable.clockInTime, startUtc),
        lt(timeEntriesTable.clockInTime, endExclusive),
        siteFilter(timeEntriesTable.siteId),
      ),
    )
    .groupBy(sql`date_trunc('week', ${timeEntriesTable.clockInTime} AT TIME ZONE ${tzLit})`);

  // Hours scheduled trend: per shift endTime week
  const hoursScheduledTrendRows = await db
    .select({
      weekStart: sql<string>`date_trunc('week', ${shiftsTable.endTime} AT TIME ZONE ${tzLit})::text`,
      hours: sql<number>`coalesce(
        sum(
          extract(epoch from ${shiftsTable.endTime} - ${shiftsTable.startTime}) / 3600.0
          * ${shiftsTable.headcount}
        ), 0
      )::float`,
    })
    .from(shiftsTable)
    .where(
      and(
        gte(shiftsTable.endTime, startUtc),
        lt(shiftsTable.endTime, endExclusive),
        lt(shiftsTable.endTime, now),
        siteFilter(shiftsTable.siteId),
      ),
    )
    .groupBy(sql`date_trunc('week', ${shiftsTable.endTime} AT TIME ZONE ${tzLit})`);

  const workedByWeek = new Map<string, number>();
  for (const r of hoursWorkedTrendRows) {
    // weekStart comes back as a local-time string like "2026-06-29 00:00:00";
    // interpret it as UTC to build the ISO-week label (already tz-shifted, no second shift).
    const dt = new Date(r.weekStart.replace(" ", "T") + "Z");
    const wk = weekBucket(dt, "UTC");
    workedByWeek.set(wk, (workedByWeek.get(wk) ?? 0) + r.hours);
  }
  const scheduledByWeek = new Map<string, number>();
  for (const r of hoursScheduledTrendRows) {
    const dt = new Date(r.weekStart.replace(" ", "T") + "Z");
    const wk = weekBucket(dt, "UTC");
    scheduledByWeek.set(wk, (scheduledByWeek.get(wk) ?? 0) + r.hours);
  }

  // Incident trend: per occurredAt week
  const incByWeek = new Map<string, number>();
  for (const inc of incidentRows) {
    const dt = inc.occurredAt instanceof Date ? inc.occurredAt : new Date(inc.occurredAt as string);
    const wk = weekBucket(dt, tz);
    incByWeek.set(wk, (incByWeek.get(wk) ?? 0) + 1);
  }

  // Enumerate all week buckets in range so even empty weeks appear in the trend
  const allWeeks = new Set<string>([
    ...revByWeek.keys(),
    ...laborByWeek.keys(),
    ...workedByWeek.keys(),
    ...scheduledByWeek.keys(),
    ...incByWeek.keys(),
  ]);
  const sortedWeeks = [...allWeeks].sort();

  const pnlTrend = sortedWeeks.map((wk) => {
    const r = revByWeek.get(wk) ?? 0;
    const l = laborByWeek.get(wk) ?? 0;
    return { bucket: wk, revenue: r, laborCost: l, profit: r - l };
  });

  const hoursTrend = sortedWeeks.map((wk) => ({
    bucket: wk,
    worked: workedByWeek.get(wk) ?? 0,
    scheduled: scheduledByWeek.get(wk) ?? 0,
  }));

  const incidentTrend = sortedWeeks.map((wk) => ({
    bucket: wk,
    count: incByWeek.get(wk) ?? 0,
  }));

  // ── 8. Per-site breakdown ──
  // Revenue per site from invoices
  const siteRevenueRows = await db
    .select({
      siteId: invoicesTable.siteId,
      total: sql<number>`coalesce(sum(${invoicesTable.totalAmount}::numeric), 0)::float`,
    })
    .from(invoicesTable)
    .where(
      and(
        gte(invoicesTable.periodStart, start),
        lte(invoicesTable.periodStart, end),
        siteFilter(invoicesTable.siteId),
      ),
    )
    .groupBy(invoicesTable.siteId);

  // Labor per site from payroll entries
  const siteLaborRows = await db
    .select({
      siteId: payrollEntriesTable.siteId,
      total: sql<number>`coalesce(sum(${payrollEntriesTable.grossPay}::numeric), 0)::float`,
    })
    .from(payrollEntriesTable)
    .where(
      and(
        gte(payrollEntriesTable.periodStart, start),
        lte(payrollEntriesTable.periodStart, end),
        siteFilter(payrollEntriesTable.siteId),
      ),
    )
    .groupBy(payrollEntriesTable.siteId);

  // Hours worked per site from time entries
  const siteWorkedRows = await db
    .select({
      siteId: timeEntriesTable.siteId,
      total: sql<number>`coalesce(sum(${timeEntriesTable.hoursWorked}::numeric), 0)::float`,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.approvalStatus, "approved"),
        gte(timeEntriesTable.clockInTime, startUtc),
        lt(timeEntriesTable.clockInTime, endExclusive),
        siteFilter(timeEntriesTable.siteId),
      ),
    )
    .groupBy(timeEntriesTable.siteId);

  // Hours scheduled per site — computed WITHOUT the assignments join below,
  // because that join fans out one row per assignment and would multiply the
  // summed shift hours by the assignment count.
  const siteScheduledRows = await db
    .select({
      siteId: shiftsTable.siteId,
      hoursScheduled: sql<number>`coalesce(
        sum(
          extract(epoch from ${shiftsTable.endTime} - ${shiftsTable.startTime}) / 3600.0
          * ${shiftsTable.headcount}
        ), 0
      )::float`,
    })
    .from(shiftsTable)
    .where(
      and(
        gte(shiftsTable.endTime, startUtc),
        lt(shiftsTable.endTime, endExclusive),
        lt(shiftsTable.endTime, now),
        siteFilter(shiftsTable.siteId),
      ),
    )
    .groupBy(shiftsTable.siteId);

  // No-shows + unfilled shifts per site
  const siteShiftRows = await db
    .select({
      siteId: shiftsTable.siteId,
      siteName: sitesTable.name,
      noShows: sql<number>`coalesce(
        count(${shiftAssignmentsTable.id}) filter (
          where ${shiftAssignmentsTable.status} = 'accepted'
          and not exists (
            select 1 from time_entries te
            where te.employee_id = ${shiftAssignmentsTable.employeeId}
              and te.shift_id = ${shiftsTable.id}
          )
        ), 0
      )::int`,
      unfilledShifts: sql<number>`coalesce(
        count(distinct ${shiftsTable.id}) filter (
          where (
            select count(*) from shift_assignments sa2
            where sa2.shift_id = ${shiftsTable.id} and sa2.status = 'accepted'
          ) < ${shiftsTable.headcount}
        ), 0
      )::int`,
    })
    .from(shiftsTable)
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .leftJoin(shiftAssignmentsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .where(
      and(
        gte(shiftsTable.endTime, startUtc),
        lt(shiftsTable.endTime, endExclusive),
        lt(shiftsTable.endTime, now),
        siteFilter(shiftsTable.siteId),
      ),
    )
    .groupBy(shiftsTable.siteId, sitesTable.name);

  // Incidents per site from shiftId -> shift -> siteId (best effort for now)
  // Incidents don't have a direct siteId FK, so we join through shifts
  const siteIncidentRows = await db
    .select({
      siteId: shiftsTable.siteId,
      count: sql<number>`count(${incidentsTable.id})::int`,
    })
    .from(incidentsTable)
    .innerJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .where(
      and(
        gte(incidentsTable.occurredAt, startUtc),
        lt(incidentsTable.occurredAt, endExclusive),
        siteFilter(shiftsTable.siteId),
      ),
    )
    .groupBy(shiftsTable.siteId);

  // Collect all site IDs
  const allSiteIds = new Set<string>([
    ...siteRevenueRows.map((r) => r.siteId).filter(Boolean) as string[],
    ...siteLaborRows.map((r) => r.siteId).filter(Boolean) as string[],
    ...siteWorkedRows.map((r) => r.siteId).filter(Boolean) as string[],
    ...siteShiftRows.map((r) => r.siteId).filter(Boolean) as string[],
  ]);

  // Look up site names for sites without a name from the joins above
  const sitesById = new Map<string, string>();
  for (const r of siteShiftRows) {
    if (r.siteId) sitesById.set(r.siteId, r.siteName ?? r.siteId);
  }

  const siteRevMap = new Map(siteRevenueRows.map((r) => [r.siteId ?? "__null", r.total]));
  const siteLaborMap = new Map(siteLaborRows.map((r) => [r.siteId ?? "__null", r.total]));
  const siteWorkedMap = new Map(siteWorkedRows.map((r) => [r.siteId ?? "__null", r.total]));
  const siteScheduledMap = new Map(siteScheduledRows.map((r) => [r.siteId ?? "__null", r.hoursScheduled]));
  const siteNoShowMap = new Map(siteShiftRows.map((r) => [r.siteId ?? "__null", r.noShows]));
  const siteUnfilledMap = new Map(siteShiftRows.map((r) => [r.siteId ?? "__null", r.unfilledShifts]));
  const siteIncMap = new Map(siteIncidentRows.map((r) => [r.siteId ?? "__null", r.count]));

  // Fetch names for any site ids we don't have names for yet
  const missingSiteIds = [...allSiteIds].filter((id) => !sitesById.has(id));
  if (missingSiteIds.length > 0) {
    const siteNameRows = await db
      .select({ id: sitesTable.id, name: sitesTable.name })
      .from(sitesTable)
      .where(sql`${sitesTable.id} = ANY(ARRAY[${sql.join(missingSiteIds.map((id) => sql`${id}::uuid`), sql`, `)}])`);
    for (const r of siteNameRows) sitesById.set(r.id, r.name);
  }

  const perSite = [...allSiteIds].map((siteId) => {
    const r = siteRevMap.get(siteId) ?? 0;
    const l = siteLaborMap.get(siteId) ?? 0;
    return {
      siteId,
      siteName: sitesById.get(siteId) ?? siteId,
      revenue: r,
      laborCost: l,
      profit: r - l,
      hoursWorked: siteWorkedMap.get(siteId) ?? 0,
      hoursScheduled: siteScheduledMap.get(siteId) ?? 0,
      noShows: siteNoShowMap.get(siteId) ?? 0,
      unfilledShifts: siteUnfilledMap.get(siteId) ?? 0,
      incidents: siteIncMap.get(siteId) ?? 0,
    };
  });

  // ── 9. Per-officer performance ──────────────────────────────────────────
  // Query A: shift completion + punctuality (from assignments → shifts → time entries)
  // Only accepted assignments for shifts that ended in the period.
  const officerShiftRows = await db
    .select({
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      shiftsAssigned: sql<number>`COUNT(DISTINCT ${shiftAssignmentsTable.shiftId})::int`,
      shiftsCompleted: sql<number>`COUNT(DISTINCT CASE WHEN ${timeEntriesTable.id} IS NOT NULL THEN ${shiftAssignmentsTable.shiftId} END)::int`,
      noShows: sql<number>`COUNT(DISTINCT CASE WHEN ${timeEntriesTable.id} IS NULL THEN ${shiftAssignmentsTable.shiftId} END)::int`,
      hoursScheduled: sql<number>`COALESCE(SUM(DISTINCT EXTRACT(EPOCH FROM (${shiftsTable.endTime} - ${shiftsTable.startTime}))/3600), 0)::float`,
      hoursWorked: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(${timeEntriesTable.clockOutTime}, NOW()) - ${timeEntriesTable.clockInTime}))/3600) FILTER (WHERE ${timeEntriesTable.id} IS NOT NULL), 0)::float`,
      // Avg minutes late: if clocked in > shift start + 5 min grace
      lateCount: sql<number>`COUNT(DISTINCT CASE WHEN ${timeEntriesTable.clockInTime} > ${shiftsTable.startTime} + INTERVAL '5 minutes' THEN ${shiftAssignmentsTable.shiftId} END)::int`,
      totalLateMinutes: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${timeEntriesTable.clockInTime} - ${shiftsTable.startTime}))/60) FILTER (WHERE ${timeEntriesTable.clockInTime} > ${shiftsTable.startTime} + INTERVAL '5 minutes'), 0)::float`,
    })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .innerJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id))
    .leftJoin(
      timeEntriesTable,
      and(
        eq(timeEntriesTable.employeeId, shiftAssignmentsTable.employeeId),
        eq(timeEntriesTable.shiftId, shiftAssignmentsTable.shiftId),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsTable.status, "accepted"),
        gte(shiftsTable.endTime, startUtc),
        lte(shiftsTable.endTime, endExclusive),
      ),
    )
    .groupBy(usersTable.id, usersTable.firstName, usersTable.lastName);

  // Query B: rejected time-entry rate
  const officerEntryRows = await db
    .select({
      employeeId: timeEntriesTable.employeeId,
      totalEntries: sql<number>`COUNT(*)::int`,
      rejectedEntries: sql<number>`COUNT(*) FILTER (WHERE ${timeEntriesTable.approvalStatus} = 'rejected')::int`,
    })
    .from(timeEntriesTable)
    .where(
      and(
        gte(timeEntriesTable.clockInTime, startUtc),
        lte(timeEntriesTable.clockInTime, endExclusive),
      ),
    )
    .groupBy(timeEntriesTable.employeeId);

  // Query C: incidents by severity per officer
  const officerIncidentRows = await db
    .select({
      employeeId: incidentsTable.employeeId,
      total: sql<number>`COUNT(*)::int`,
      low: sql<number>`COUNT(*) FILTER (WHERE ${incidentsTable.severity} = 'low')::int`,
      medium: sql<number>`COUNT(*) FILTER (WHERE ${incidentsTable.severity} = 'medium')::int`,
      high: sql<number>`COUNT(*) FILTER (WHERE ${incidentsTable.severity} = 'high')::int`,
      critical: sql<number>`COUNT(*) FILTER (WHERE ${incidentsTable.severity} = 'critical')::int`,
    })
    .from(incidentsTable)
    .where(
      and(
        gte(incidentsTable.occurredAt, startUtc),
        lte(incidentsTable.occurredAt, endExclusive),
      ),
    )
    .groupBy(incidentsTable.employeeId);

  // Build lookup maps
  const entryMap = new Map(officerEntryRows.map((r) => [r.employeeId, r]));
  const incidentMap = new Map(officerIncidentRows.map((r) => [r.employeeId, r]));

  const perOfficer = officerShiftRows.map((r) => {
    const entries = entryMap.get(r.userId);
    const incidents = incidentMap.get(r.userId);

    const attendanceRate =
      r.shiftsAssigned > 0
        ? Math.round((r.shiftsCompleted / r.shiftsAssigned) * 1000) / 10
        : 100;
    const onTimeRate =
      r.shiftsCompleted > 0
        ? Math.round(((r.shiftsCompleted - r.lateCount) / r.shiftsCompleted) * 1000) / 10
        : 100;
    const avgMinutesLate =
      r.lateCount > 0 ? Math.round((r.totalLateMinutes / r.lateCount) * 10) / 10 : 0;
    const rejectedEntryRate =
      entries && entries.totalEntries > 0
        ? Math.round((entries.rejectedEntries / entries.totalEntries) * 1000) / 10
        : 0;
    // Composite reliability: 60% attendance + 40% punctuality
    const reliabilityScore = Math.round((0.6 * attendanceRate + 0.4 * onTimeRate) * 10) / 10;

    return {
      userId: r.userId,
      firstName: r.firstName ?? "",
      lastName: r.lastName ?? "",
      shiftsAssigned: r.shiftsAssigned,
      shiftsCompleted: r.shiftsCompleted,
      noShows: r.noShows,
      hoursScheduled: Math.round(r.hoursScheduled * 10) / 10,
      hoursWorked: Math.round(r.hoursWorked * 10) / 10,
      attendanceRate,
      onTimeRate,
      avgMinutesLate,
      rejectedEntryRate,
      incidentTotal: incidents?.total ?? 0,
      incidentsBySeverity: {
        low: incidents?.low ?? 0,
        medium: incidents?.medium ?? 0,
        high: incidents?.high ?? 0,
        critical: incidents?.critical ?? 0,
      },
      reliabilityScore,
    };
  });

  const officerSummary = {
    totalOfficers: perOfficer.length,
    totalNoShows: perOfficer.reduce((s, r) => s + r.noShows, 0),
    avgAttendanceRate:
      perOfficer.length > 0
        ? Math.round((perOfficer.reduce((s, r) => s + r.attendanceRate, 0) / perOfficer.length) * 10) / 10
        : 100,
    avgOnTimeRate:
      perOfficer.length > 0
        ? Math.round((perOfficer.reduce((s, r) => s + r.onTimeRate, 0) / perOfficer.length) * 10) / 10
        : 100,
  };

  return {
    revenue,
    laborCost,
    profit,
    marginPct,
    hoursWorked,
    hoursScheduled,
    coveragePct,
    noShowCount,
    unfilledCount,
    missedShifts,
    incidentTotal,
    incidentsBySeverity,
    incidentsByStatus,
    pnlTrend,
    hoursTrend,
    incidentTrend,
    perSite,
    officerSummary,
    perOfficer,
  };
}

router.get("/analytics/summary", requireAdmin, async (req, res): Promise<void> => {
  const range = parseRange(req, res);
  if (!range) return;
  const client = await resolveClientFilter(range.clientId, res);
  if (client === undefined) return;
  res.json(await computeAnalyticsSummary(range.start, range.end, client?.id));
});

/**
 * CSV cell escaping — same contract as the Pay Run export:
 *   - Wrap in quotes if the value contains `,`, `"`, newline, tab, or CR.
 *   - Double up embedded quotes.
 *   - Defang leading `=`, `+`, `-`, `@`, `|`, tab, CR by prefixing `'`
 *     (Excel / Sheets treat these as formula starters).
 */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  if (s.length > 0 && /^[=+\-@|\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r\t]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Filesystem-safe slug for a client name (e.g. "Acme Corp." → "acme-corp"). */
export function clientFileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client"
  );
}

function exportFilename(
  start: string,
  end: string,
  ext: "csv" | "pdf",
  clientName?: string,
): string {
  const safeShort = brand.shortName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const clientPart = clientName ? `-${clientFileSlug(clientName)}` : "";
  return `${safeShort}-analytics${clientPart}-${start}_${end}.${ext}`;
}

router.get("/analytics/export.csv", requireAdmin, async (req, res): Promise<void> => {
  const range = parseRange(req, res);
  if (!range) return;
  const client = await resolveClientFilter(range.clientId, res);
  if (client === undefined) return;
  const s = await computeAnalyticsSummary(range.start, range.end, client?.id);

  const lines: string[] = [];
  const row = (...cells: unknown[]) => lines.push(cells.map(csvEscape).join(","));

  // ── Summary KPI section ──
  row("Metric", "Value");
  row("Period start", range.start);
  row("Period end", range.end);
  if (client) row("Client", client.name);
  row("Revenue (USD)", s.revenue.toFixed(2));
  row("Labor cost (USD)", s.laborCost.toFixed(2));
  row("Profit (USD)", s.profit.toFixed(2));
  row("Margin (%)", s.marginPct.toFixed(1));
  row("Hours worked", s.hoursWorked.toFixed(2));
  row("Hours scheduled", s.hoursScheduled.toFixed(2));
  row("Coverage (%)", s.coveragePct.toFixed(1));
  row("No-shows", s.noShowCount);
  row("Unfilled shifts", s.unfilledCount);
  row("Incidents (total)", s.incidentTotal);
  row("Incidents low", s.incidentsBySeverity.low ?? 0);
  row("Incidents medium", s.incidentsBySeverity.medium ?? 0);
  row("Incidents high", s.incidentsBySeverity.high ?? 0);
  row("Incidents critical", s.incidentsBySeverity.critical ?? 0);
  row("Incidents open", s.incidentsByStatus.open ?? 0);
  row("Incidents investigating", s.incidentsByStatus.investigating ?? 0);
  row("Incidents closed", s.incidentsByStatus.closed ?? 0);
  lines.push("");

  // ── Per-site breakdown section ──
  row(
    "Site", "Revenue (USD)", "Labor cost (USD)", "Profit (USD)",
    "Hours worked", "Hours scheduled", "No-shows", "Unfilled shifts", "Incidents",
  );
  const sites = [...s.perSite].sort((a, b) => b.revenue - a.revenue);
  for (const site of sites) {
    row(
      site.siteName,
      site.revenue.toFixed(2),
      site.laborCost.toFixed(2),
      site.profit.toFixed(2),
      site.hoursWorked.toFixed(2),
      site.hoursScheduled.toFixed(2),
      site.noShows,
      site.unfilledShifts,
      site.incidents,
    );
  }

  // CRLF — Excel-friendliest line ending.
  const csv = lines.join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${exportFilename(range.start, range.end, "csv", client?.name)}"`,
  );
  res.send(csv);
});

router.get("/analytics/export.pdf", requireAdmin, async (req, res): Promise<void> => {
  const range = parseRange(req, res);
  if (!range) return;
  const client = await resolveClientFilter(range.clientId, res);
  if (client === undefined) return;
  const s = await computeAnalyticsSummary(range.start, range.end, client?.id);
  const payload = buildAnalyticsReportPdf(s, range.start, range.end, client?.name);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${exportFilename(range.start, range.end, "pdf", client?.name)}"`,
  );
  payload.stream.pipe(res);
});

export default router;

