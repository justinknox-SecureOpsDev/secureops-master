/**
 * Analytics aggregation for the admin dashboard (`/analytics/*`).
 *
 * Money rules deliberately MIRROR the billing/payroll engines so the
 * dashboard never disagrees with an invoice or a pay run:
 *   - Revenue per approved hour = shift.billRate, else site.defaultBillRate,
 *     else $0 (unpriceable hours still count as worked hours).
 *   - Labor cost per approved hour = time_entries.payRateOverride, else
 *     shift.payRate, else employees.hourlyRate, else $0 (same precedence as
 *     the Payroll Board).
 *   - Federal-holiday hours (clock-in date in the business timezone) apply
 *     the 1.5× premium to BOTH sides, with the premium rate rounded to cents
 *     BEFORE multiplying by hours — identical to invoiceSync/payroll.
 *
 * All "which calendar day/week" decisions use the business timezone
 * (PAYROLL_TIMEZONE, default America/Chicago), never UTC.
 */
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  shiftsTable,
  sitesTable,
  clientsTable,
  usersTable,
  employeesTable,
  shiftAssignmentsTable,
  incidentsTable,
} from "@workspace/db";
import { getFederalHolidayName, HOLIDAY_PAY_MULTIPLIER } from "./holidays";
import { businessTimeZone, startOfBusinessWeek, businessDateIso } from "./businessTime";

/** An officer is "punctual" iff clock-in ≤ shift start + this grace. */
export const PUNCTUALITY_GRACE_MS = 5 * 60 * 1000;

export interface AnalyticsRange {
  /** Inclusive UTC instant (local midnight of the start date). */
  start: Date;
  /** Exclusive UTC instant (local midnight after the end date). */
  end: Date;
  clientId?: string | undefined;
  /** Injectable for tests; defaults to wall clock. */
  now?: Date | undefined;
}

export interface AnalyticsWeekBucket {
  weekStart: string;
  revenue: number;
  laborCost: number;
  pnl: number;
  hoursWorked: number;
  incidentCount: number;
}

export interface AnalyticsSiteRow {
  siteId: string;
  siteName: string;
  clientName: string | null;
  revenue: number;
  laborCost: number;
  pnl: number;
  hoursWorked: number;
  coveragePct: number | null;
}

export interface AnalyticsPerOfficerRow {
  userId: string;
  firstName: string;
  lastName: string;
  shiftsAssigned: number;
  shiftsCompleted: number;
  noShows: number;
  hoursScheduled: number;
  hoursWorked: number;
  attendanceRate: number;
  onTimeRate: number;
  avgMinutesLate: number;
  rejectedEntryRate: number;
  incidentTotal: number;
  incidentsBySeverity: { low: number; medium: number; high: number; critical: number };
  reliabilityScore: number;
}

export interface AnalyticsOfficerSummary {
  totalOfficers: number;
  totalNoShows: number;
  avgAttendanceRate: number;
  avgOnTimeRate: number;
}

export interface AnalyticsSummary {
  revenue: number;
  laborCost: number;
  pnl: number;
  marginPct: number | null;
  hoursWorked: number;
  hoursScheduled: number;
  coveragePct: number | null;
  noShows: number;
  unfilledShifts: number;
  incidents: {
    total: number;
    low: number;
    medium: number;
    high: number;
    critical: number;
    open: number;
    resolved: number;
  };
  weeklyTrend: AnalyticsWeekBucket[];
  sites: AnalyticsSiteRow[];
  officerSummary: AnalyticsOfficerSummary;
  perOfficer: AnalyticsPerOfficerRow[];
}

export interface AnalyticsOfficerRow {
  employeeId: string;
  name: string;
  hoursWorked: number;
  shiftsCompleted: number;
  incidentsFiled: number;
  punctualityPct: number | null;
  trend: { weekStart: string; hoursWorked: number }[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const pct1 = (x: number) => Math.round(x * 10) / 10;

/** Zero-filled ordered week keys (business-TZ Monday ISO dates) covering [start, end). */
function weekKeysFor(start: Date, end: Date, tz: string): string[] {
  const keys: string[] = [];
  let w = startOfBusinessWeek(start, tz);
  // Cap defensively: route validation already bounds the range.
  for (let i = 0; i < 120 && w.getTime() < end.getTime(); i++) {
    keys.push(businessDateIso(w, tz));
    // Midday 7.5 days later is inside the next business week even across DST.
    w = startOfBusinessWeek(new Date(w.getTime() + 7.5 * 86_400_000), tz);
  }
  return keys;
}

const weekKeyOf = (instant: Date, tz: string) => businessDateIso(startOfBusinessWeek(instant, tz), tz);

/** Premium-aware effective rate: holiday hours get 1.5×, rounded to cents FIRST. */
function effectiveRate(baseRate: number, clockInTime: Date): number {
  if (baseRate <= 0) return 0;
  return getFederalHolidayName(clockInTime)
    ? Math.round(baseRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100
    : baseRate;
}

interface EntryRow {
  employeeId: string;
  shiftId: string | null;
  hoursWorked: string | null;
  clockInTime: Date;
  clockOutTime: Date | null;
  payRateOverride: string | null;
  shiftPayRate: string | null;
  shiftBillRate: string | null;
  shiftStartTime: Date | null;
  shiftEndTime: Date | null;
  siteId: string | null;
  siteName: string | null;
  siteBillRate: string | null;
  clientName: string | null;
  employeeRate: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** Approved time entries in range with everything needed to price them. */
async function loadApprovedEntries(range: AnalyticsRange): Promise<EntryRow[]> {
  const siteJoin = sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`;
  const where = [
    eq(timeEntriesTable.approvalStatus, "approved"),
    gte(timeEntriesTable.clockInTime, range.start),
    lt(timeEntriesTable.clockInTime, range.end),
  ];
  if (range.clientId) where.push(eq(sitesTable.clientId, range.clientId));
  return db
    .select({
      employeeId: timeEntriesTable.employeeId,
      shiftId: timeEntriesTable.shiftId,
      hoursWorked: timeEntriesTable.hoursWorked,
      clockInTime: timeEntriesTable.clockInTime,
      clockOutTime: timeEntriesTable.clockOutTime,
      payRateOverride: timeEntriesTable.payRateOverride,
      shiftPayRate: shiftsTable.payRate,
      shiftBillRate: shiftsTable.billRate,
      shiftStartTime: shiftsTable.startTime,
      shiftEndTime: shiftsTable.endTime,
      siteId: sitesTable.id,
      siteName: sitesTable.name,
      siteBillRate: sitesTable.defaultBillRate,
      clientName: clientsTable.name,
      employeeRate: employeesTable.hourlyRate,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, siteJoin)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
    .leftJoin(employeesTable, eq(employeesTable.userId, timeEntriesTable.employeeId))
    .leftJoin(usersTable, eq(usersTable.id, timeEntriesTable.employeeId))
    .where(and(...where));
}

interface IncidentRow {
  severity: string;
  status: string;
  occurredAt: Date;
  employeeId: string;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Incidents in range. Under a client filter only incidents tied (via their
 * shift) to that client's sites qualify — unattributed incidents can't be
 * assigned to a client.
 */
async function loadIncidents(range: AnalyticsRange): Promise<IncidentRow[]> {
  const cols = {
    severity: incidentsTable.severity,
    status: incidentsTable.status,
    occurredAt: incidentsTable.occurredAt,
    employeeId: incidentsTable.employeeId,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
  };
  const timeWhere = [
    gte(incidentsTable.occurredAt, range.start),
    lt(incidentsTable.occurredAt, range.end),
  ];
  if (!range.clientId) {
    return db
      .select(cols)
      .from(incidentsTable)
      .leftJoin(usersTable, eq(usersTable.id, incidentsTable.employeeId))
      .where(and(...timeWhere));
  }
  return db
    .select(cols)
    .from(incidentsTable)
    .innerJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .innerJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .leftJoin(usersTable, eq(usersTable.id, incidentsTable.employeeId))
    .where(and(...timeWhere, eq(sitesTable.clientId, range.clientId)));
}

/** Priced hours for one approved entry (0-hour / open entries contribute nothing). */
function priceEntry(e: EntryRow): { hours: number; revenue: number; laborCost: number } {
  const hours = parseFloat(String(e.hoursWorked ?? "0"));
  if (!isFinite(hours) || hours <= 0) return { hours: 0, revenue: 0, laborCost: 0 };
  const shiftBill = parseFloat(String(e.shiftBillRate ?? "0"));
  const siteBill = parseFloat(String(e.siteBillRate ?? "0"));
  const billBase = shiftBill > 0 ? shiftBill : siteBill > 0 ? siteBill : 0;
  // Same null-coalescing precedence as the Payroll Board (payroll.ts).
  const payBase = parseFloat(String(e.payRateOverride ?? e.shiftPayRate ?? e.employeeRate ?? "0"));
  const revenue = hours * effectiveRate(billBase, e.clockInTime);
  const laborCost = hours * effectiveRate(payBase > 0 ? payBase : 0, e.clockInTime);
  return { hours, revenue, laborCost };
}

/**
 * Per-officer performance table for the summary payload. Ported from the
 * original analytics implementation so the response contract (and the admin
 * portal's Officer Performance table) is unchanged:
 *   - population = accepted assignments on shifts that END inside the range
 *     (deliberately NOT client-filtered — officer reliability is a property of
 *     the person, not of one client's sites);
 *   - completed = a time entry exists for (employee, shift); late = clock-in
 *     more than 5 minutes after shift start;
 *   - reliability = 60% attendance + 40% punctuality.
 */
async function loadPerOfficer(range: AnalyticsRange): Promise<{
  perOfficer: AnalyticsPerOfficerRow[];
  officerSummary: AnalyticsOfficerSummary;
}> {
  // Query A: shift completion + punctuality (assignments → shifts → time entries)
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
        gte(shiftsTable.endTime, range.start),
        lte(shiftsTable.endTime, range.end),
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
        gte(timeEntriesTable.clockInTime, range.start),
        lte(timeEntriesTable.clockInTime, range.end),
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
        gte(incidentsTable.occurredAt, range.start),
        lte(incidentsTable.occurredAt, range.end),
      ),
    )
    .groupBy(incidentsTable.employeeId);

  const entryMap = new Map(officerEntryRows.map((r) => [r.employeeId, r]));
  const incidentMap = new Map(officerIncidentRows.map((r) => [r.employeeId, r]));

  const perOfficer: AnalyticsPerOfficerRow[] = officerShiftRows.map((r) => {
    const officerEntries = entryMap.get(r.userId);
    const officerIncidents = incidentMap.get(r.userId);

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
      officerEntries && officerEntries.totalEntries > 0
        ? Math.round((officerEntries.rejectedEntries / officerEntries.totalEntries) * 1000) / 10
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
      incidentTotal: officerIncidents?.total ?? 0,
      incidentsBySeverity: {
        low: officerIncidents?.low ?? 0,
        medium: officerIncidents?.medium ?? 0,
        high: officerIncidents?.high ?? 0,
        critical: officerIncidents?.critical ?? 0,
      },
      reliabilityScore,
    };
  });

  const officerSummary: AnalyticsOfficerSummary = {
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

  return { perOfficer, officerSummary };
}

export async function computeAnalyticsSummary(range: AnalyticsRange): Promise<AnalyticsSummary> {
  const tz = businessTimeZone();
  const now = range.now ?? new Date();

  const shiftWhere = [gte(shiftsTable.startTime, range.start), lt(shiftsTable.startTime, range.end)];
  const shiftClientWhere = range.clientId ? [eq(sitesTable.clientId, range.clientId)] : [];

  const [entries, shifts, acceptedAssignments, entryPairs, incidents, officerBlock] = await Promise.all([
    loadApprovedEntries(range),
    db
      .select({
        id: shiftsTable.id,
        siteId: shiftsTable.siteId,
        startTime: shiftsTable.startTime,
        endTime: shiftsTable.endTime,
        headcount: shiftsTable.headcount,
      })
      .from(shiftsTable)
      .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
      .where(and(...shiftWhere, ...shiftClientWhere)),
    db
      .select({
        shiftId: shiftAssignmentsTable.shiftId,
        employeeId: shiftAssignmentsTable.employeeId,
      })
      .from(shiftAssignmentsTable)
      .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
      .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
      .where(and(eq(shiftAssignmentsTable.status, "accepted"), ...shiftWhere, ...shiftClientWhere)),
    db
      .selectDistinct({
        shiftId: timeEntriesTable.shiftId,
        employeeId: timeEntriesTable.employeeId,
      })
      .from(timeEntriesTable)
      .innerJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
      .where(and(...shiftWhere)),
    loadIncidents(range),
    loadPerOfficer(range),
  ]);

  let revenue = 0;
  let laborCost = 0;
  let hoursWorked = 0;

  const weekKeys = weekKeysFor(range.start, range.end, tz);
  const weeks = new Map<string, { revenue: number; laborCost: number; hours: number; incidents: number }>();
  for (const k of weekKeys) weeks.set(k, { revenue: 0, laborCost: 0, hours: 0, incidents: 0 });
  const weekOf = (instant: Date) => weeks.get(weekKeyOf(instant, tz));

  type SiteAgg = {
    siteId: string;
    siteName: string;
    clientName: string | null;
    revenue: number;
    laborCost: number;
    hours: number;
    scheduledHours: number;
  };
  const siteAggs = new Map<string, SiteAgg>();
  const siteAggFor = (siteId: string | null, siteName: string | null, clientName: string | null): SiteAgg => {
    const key = siteId ?? "unassigned";
    let agg = siteAggs.get(key);
    if (!agg) {
      agg = {
        siteId: key,
        siteName: siteName ?? "Unassigned",
        clientName,
        revenue: 0,
        laborCost: 0,
        hours: 0,
        scheduledHours: 0,
      };
      siteAggs.set(key, agg);
    }
    return agg;
  };

  for (const e of entries) {
    const p = priceEntry(e);
    if (p.hours <= 0) continue;
    revenue += p.revenue;
    laborCost += p.laborCost;
    hoursWorked += p.hours;
    const w = weekOf(e.clockInTime);
    if (w) {
      w.revenue += p.revenue;
      w.laborCost += p.laborCost;
      w.hours += p.hours;
    }
    const s = siteAggFor(e.siteId, e.siteName, e.clientName);
    s.revenue += p.revenue;
    s.laborCost += p.laborCost;
    s.hours += p.hours;
  }

  // Scheduled hours & staffing gaps. Shift population = shifts STARTING in
  // range; "ended" is judged against the wall clock, never shift.status
  // (which stays "upcoming" forever).
  let hoursScheduled = 0;
  let unfilledShifts = 0;
  let noShows = 0;
  const acceptedByShift = new Map<string, number>();
  for (const a of acceptedAssignments) {
    acceptedByShift.set(a.shiftId, (acceptedByShift.get(a.shiftId) ?? 0) + 1);
  }
  const pairSet = new Set(entryPairs.map((p) => `${p.shiftId}|${p.employeeId}`));
  const endedShiftIds = new Set<string>();
  const shiftSiteScheduled = new Map<string, string | null>();
  for (const s of shifts) {
    const durH = Math.max(0, (s.endTime.getTime() - s.startTime.getTime()) / 3_600_000);
    const headcount = s.headcount ?? 1;
    hoursScheduled += durH * headcount;
    shiftSiteScheduled.set(s.id, s.siteId);
    if (s.siteId && siteAggs.has(s.siteId)) {
      siteAggs.get(s.siteId)!.scheduledHours += durH * headcount;
    } else if (s.siteId) {
      // Site had scheduled shifts but no worked hours yet — still surface it.
      const agg = siteAggFor(s.siteId, null, null);
      agg.scheduledHours += durH * headcount;
    }
    const ended = s.endTime.getTime() < now.getTime();
    if (ended) {
      endedShiftIds.add(s.id);
      if (headcount > 0 && (acceptedByShift.get(s.id) ?? 0) < headcount) unfilledShifts++;
    }
  }
  for (const a of acceptedAssignments) {
    if (endedShiftIds.has(a.shiftId) && !pairSet.has(`${a.shiftId}|${a.employeeId}`)) noShows++;
  }

  // Sites that only appeared via scheduled shifts still need names.
  const unnamed = [...siteAggs.values()].filter((s) => s.siteName === "Unassigned" && s.siteId !== "unassigned");
  if (unnamed.length > 0) {
    const named = await db
      .select({ id: sitesTable.id, name: sitesTable.name, clientName: clientsTable.name })
      .from(sitesTable)
      .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id));
    const byId = new Map(named.map((n) => [n.id, n]));
    for (const s of unnamed) {
      const n = byId.get(s.siteId);
      if (n) {
        s.siteName = n.name;
        s.clientName = n.clientName;
      }
    }
  }

  const incidentCounts = { total: 0, low: 0, medium: 0, high: 0, critical: 0, open: 0, resolved: 0 };
  for (const i of incidents) {
    incidentCounts.total++;
    if (i.severity === "low") incidentCounts.low++;
    else if (i.severity === "medium") incidentCounts.medium++;
    else if (i.severity === "high") incidentCounts.high++;
    else if (i.severity === "critical") incidentCounts.critical++;
    if (i.status === "resolved") incidentCounts.resolved++;
    else incidentCounts.open++;
    const w = weekOf(i.occurredAt);
    if (w) w.incidents++;
  }

  const weeklyTrend: AnalyticsWeekBucket[] = weekKeys.map((k) => {
    const w = weeks.get(k)!;
    return {
      weekStart: k,
      revenue: r2(w.revenue),
      laborCost: r2(w.laborCost),
      pnl: r2(w.revenue - w.laborCost),
      hoursWorked: r2(w.hours),
      incidentCount: w.incidents,
    };
  });

  const sites: AnalyticsSiteRow[] = [...siteAggs.values()]
    .map((s) => ({
      siteId: s.siteId,
      siteName: s.siteName,
      clientName: s.clientName,
      revenue: r2(s.revenue),
      laborCost: r2(s.laborCost),
      pnl: r2(s.revenue - s.laborCost),
      hoursWorked: r2(s.hours),
      coveragePct: s.scheduledHours > 0 ? pct1((s.hours / s.scheduledHours) * 100) : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    revenue: r2(revenue),
    laborCost: r2(laborCost),
    pnl: r2(revenue - laborCost),
    marginPct: revenue > 0 ? pct1(((revenue - laborCost) / revenue) * 100) : null,
    hoursWorked: r2(hoursWorked),
    hoursScheduled: r2(hoursScheduled),
    coveragePct: hoursScheduled > 0 ? pct1((hoursWorked / hoursScheduled) * 100) : null,
    noShows,
    unfilledShifts,
    incidents: incidentCounts,
    weeklyTrend,
    sites,
    officerSummary: officerBlock.officerSummary,
    perOfficer: officerBlock.perOfficer,
  };
}

export async function computeAnalyticsOfficers(range: AnalyticsRange): Promise<AnalyticsOfficerRow[]> {
  const tz = businessTimeZone();
  const now = range.now ?? new Date();

  const [entries, incidents] = await Promise.all([loadApprovedEntries(range), loadIncidents(range)]);

  const weekKeys = weekKeysFor(range.start, range.end, tz);

  type OfficerAgg = {
    employeeId: string;
    name: string;
    hours: number;
    weekHours: Map<string, number>;
    punctualTotal: number;
    punctualOnTime: number;
    completedShiftIds: Set<string>;
    incidentsFiled: number;
  };
  const officers = new Map<string, OfficerAgg>();
  const officerFor = (employeeId: string, first: string | null, last: string | null): OfficerAgg => {
    let agg = officers.get(employeeId);
    if (!agg) {
      agg = {
        employeeId,
        name: [first, last].filter(Boolean).join(" ") || "Unknown officer",
        hours: 0,
        weekHours: new Map(weekKeys.map((k) => [k, 0])),
        punctualTotal: 0,
        punctualOnTime: 0,
        completedShiftIds: new Set(),
        incidentsFiled: 0,
      };
      officers.set(employeeId, agg);
    }
    return agg;
  };

  for (const e of entries) {
    const o = officerFor(e.employeeId, e.firstName, e.lastName);
    const p = priceEntry(e);
    if (p.hours > 0) {
      o.hours += p.hours;
      const k = weekKeyOf(e.clockInTime, tz);
      if (o.weekHours.has(k)) o.weekHours.set(k, (o.weekHours.get(k) ?? 0) + p.hours);
    }
    // Punctuality is judged per entry that is attached to a shift, against
    // the shift's scheduled start + grace. Overnight shifts work naturally:
    // both start and clock-in are absolute instants.
    if (e.shiftId && e.shiftStartTime) {
      o.punctualTotal++;
      if (e.clockInTime.getTime() <= e.shiftStartTime.getTime() + PUNCTUALITY_GRACE_MS) {
        o.punctualOnTime++;
      }
    }
    // A shift counts as completed once it has ENDED and the officer's
    // approved entry there is closed out.
    if (e.shiftId && e.shiftEndTime && e.shiftEndTime.getTime() < now.getTime() && e.clockOutTime) {
      o.completedShiftIds.add(e.shiftId);
    }
  }

  for (const i of incidents) {
    const o = officerFor(i.employeeId, i.firstName, i.lastName);
    o.incidentsFiled++;
  }

  return [...officers.values()]
    .map((o) => ({
      employeeId: o.employeeId,
      name: o.name,
      hoursWorked: r2(o.hours),
      shiftsCompleted: o.completedShiftIds.size,
      incidentsFiled: o.incidentsFiled,
      punctualityPct: o.punctualTotal > 0 ? pct1((o.punctualOnTime / o.punctualTotal) * 100) : null,
      trend: weekKeys.map((k) => ({ weekStart: k, hoursWorked: r2(o.weekHours.get(k) ?? 0) })),
    }))
    .sort((a, b) => b.hoursWorked - a.hoursWorked);
}
