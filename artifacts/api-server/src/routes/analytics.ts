/**
 * Admin analytics endpoints.
 *
 *   GET  /analytics/summary   — contract-first (openapi.yaml), zod-validated
 *   GET  /analytics/officers  — contract-first (openapi.yaml), zod-validated
 *   POST /admin/analytics/export-csv — off-spec download (mirrors /admin/exports/csv)
 *   POST /admin/analytics/export-pdf — off-spec download (mirrors /admin/exports/pdf)
 *
 * Date params are calendar dates interpreted in the business timezone
 * (PAYROLL_TIMEZONE): the window is [local midnight of start, local midnight
 * AFTER end) — i.e. both dates inclusive. Range is capped to bound DB work.
 */
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import PDFDocument from "pdfkit";
import type { Response } from "express";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, usersTable, shiftsTable, shiftAssignmentsTable, timeEntriesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { exportLimiter } from "../middlewares/rateLimit";
import { logger } from "../lib/logger";
import { drawBrandHeader } from "../lib/pdfHeader";
import { brand } from "../lib/brandConfig";
import {
  computeAnalyticsSummary,
  computeAnalyticsOfficers,
  type AnalyticsRange,
  type AnalyticsSummary,
  type AnalyticsOfficerRow,
} from "../lib/analytics";
import { businessTimeZone, businessDateToUtc, businessDayWindow } from "../lib/businessTime";

const router: IRouter = Router();

const MAX_RANGE_DAYS = 366;

const paramsSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  clientId: z.uuid().optional(),
});
type Params = z.infer<typeof paramsSchema>;

/** Parse + bound the requested window; responds 400 itself when invalid. */
function resolveRange(input: unknown, res: Response): AnalyticsRange | null {
  const parsed = paramsSchema.safeParse(input);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return null;
  }
  const { start, end, clientId } = parsed.data as Params;
  const tz = businessTimeZone();
  const startUtc = businessDateToUtc(start, tz);
  const endDayStart = businessDateToUtc(end, tz);
  if (endDayStart.getTime() < startUtc.getTime()) {
    res.status(400).json({ error: "Bad Request", message: "end must be on or after start" });
    return null;
  }
  if (endDayStart.getTime() - startUtc.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    res.status(400).json({
      error: "Bad Request",
      message: `Date range is capped at ${MAX_RANGE_DAYS} days — narrow the window.`,
    });
    return null;
  }
  // End-exclusive bound = the local midnight AFTER the end date (DST-safe).
  const endUtc = businessDayWindow(new Date(endDayStart.getTime() + 12 * 3_600_000), tz).endOfDay;
  return { start: startUtc, end: endUtc, clientId };
}

router.get("/analytics/summary", requireAdmin, async (req, res): Promise<void> => {
  const range = resolveRange(req.query, res);
  if (!range) return;
  try {
    res.json(await computeAnalyticsSummary(range));
  } catch (err) {
    logger.error({ err }, "[analytics] summary failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not compute analytics." });
  }
});

router.get("/analytics/officers", requireAdmin, async (req, res): Promise<void> => {
  const range = resolveRange(req.query, res);
  if (!range) return;
  try {
    res.json(await computeAnalyticsOfficers(range));
  } catch (err) {
    logger.error({ err }, "[analytics] officers failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not compute analytics." });
  }
});

// ---------- officer weekly history ------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isoWeek(monday: Date): number {
  const jan4 = new Date(Date.UTC(monday.getUTCFullYear(), 0, 4));
  const startOfYear = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400_000);
  return Math.round((monday.getTime() - startOfYear.getTime()) / (7 * 86400_000)) + 1;
}

/** Get the ISO week label (YYYY-Www) for a Date in the given timezone. */
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

/**
 * Weekly-bucketed performance history for one officer over the trailing N
 * ISO weeks (including the current week). Same admin-only analytics boundary
 * and the same attendance / punctuality / reliability definitions as the
 * per-officer summary table, but grouped by ISO week so trends are visible.
 */
router.get("/analytics/officer-history", requireAdmin, async (req, res): Promise<void> => {
  const { userId, weeks: weeksRaw } = req.query as { userId?: string; weeks?: string };
  if (!userId || !UUID_RE.test(userId)) {
    res.status(400).json({ error: "userId must be a valid UUID" });
    return;
  }
  let weeks = 12;
  if (weeksRaw !== undefined && weeksRaw !== "") {
    const n = Number(weeksRaw);
    if (!Number.isInteger(n) || n < 4 || n > 26) {
      res.status(400).json({ error: "weeks must be an integer between 4 and 26" });
      return;
    }
    weeks = n;
  }

  const [user] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const tz = businessTimeZone();
  const now = new Date();

  // Today's calendar date in the business timezone → Monday of the current
  // ISO week → back up (weeks - 1) more weeks for the window start.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pm: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") pm[p.type] = p.value;
  const todayUtc = new Date(Date.UTC(Number(pm.year), Number(pm.month) - 1, Number(pm.day)));
  const currentMonday = new Date(
    todayUtc.getTime() - ((todayUtc.getUTCDay() + 6) % 7) * 86400_000,
  );
  const firstMonday = new Date(currentMonday.getTime() - (weeks - 1) * 7 * 86400_000);
  const firstMondayStr = firstMonday.toISOString().slice(0, 10);
  const startUtc = businessDateToUtc(firstMondayStr, tz);

  // One row per ISO week (business timezone) of shift end. Same joins and
  // metric definitions as the per-officer block in computeAnalyticsSummary:
  // accepted assignments on shifts that have already ended; completed = a
  // time entry exists for (employee, shift); late = clock-in more than 5
  // minutes after shift start.
  const tzLit = sql.raw(`'${tz.replace(/'/g, "''")}'`);
  const weekExpr = sql`date_trunc('week', ${shiftsTable.endTime} AT TIME ZONE ${tzLit})`;
  const rows = await db
    .select({
      weekStart: sql<string>`${weekExpr}::text`,
      shiftsAssigned: sql<number>`COUNT(DISTINCT ${shiftAssignmentsTable.shiftId})::int`,
      shiftsCompleted: sql<number>`COUNT(DISTINCT CASE WHEN ${timeEntriesTable.id} IS NOT NULL THEN ${shiftAssignmentsTable.shiftId} END)::int`,
      noShows: sql<number>`COUNT(DISTINCT CASE WHEN ${timeEntriesTable.id} IS NULL THEN ${shiftAssignmentsTable.shiftId} END)::int`,
      hoursWorked: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(${timeEntriesTable.clockOutTime}, NOW()) - ${timeEntriesTable.clockInTime}))/3600) FILTER (WHERE ${timeEntriesTable.id} IS NOT NULL), 0)::float`,
      lateCount: sql<number>`COUNT(DISTINCT CASE WHEN ${timeEntriesTable.clockInTime} > ${shiftsTable.startTime} + INTERVAL '5 minutes' THEN ${shiftAssignmentsTable.shiftId} END)::int`,
    })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .leftJoin(
      timeEntriesTable,
      and(
        eq(timeEntriesTable.employeeId, shiftAssignmentsTable.employeeId),
        eq(timeEntriesTable.shiftId, shiftAssignmentsTable.shiftId),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsTable.employeeId, userId),
        eq(shiftAssignmentsTable.status, "accepted"),
        gte(shiftsTable.endTime, startUtc),
        lt(shiftsTable.endTime, now),
      ),
    )
    .groupBy(weekExpr);

  // Key rows by ISO week label (weekStart already tz-shifted → treat as UTC).
  const byWeek = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const dt = new Date(r.weekStart.replace(" ", "T") + "Z");
    byWeek.set(weekBucket(dt, "UTC"), r);
  }

  // Enumerate every week in the window so empty weeks appear as gaps.
  const points = [];
  for (let i = 0; i < weeks; i++) {
    const monday = new Date(firstMonday.getTime() + i * 7 * 86400_000);
    const bucket = weekBucket(monday, "UTC");
    const r = byWeek.get(bucket);
    if (!r) {
      points.push({
        bucket,
        weekStart: monday.toISOString().slice(0, 10),
        shiftsAssigned: 0,
        shiftsCompleted: 0,
        noShows: 0,
        hoursWorked: 0,
        attendanceRate: null,
        punctualityEligible: 0,
        onTimeRate: null,
        reliabilityScore: null,
      });
      continue;
    }
    const attendanceRate =
      r.shiftsAssigned > 0
        ? Math.round((r.shiftsCompleted / r.shiftsAssigned) * 1000) / 10
        : null;
    const onTimeRate =
      r.shiftsCompleted > 0
        ? Math.round(((r.shiftsCompleted - r.lateCount) / r.shiftsCompleted) * 1000) / 10
        : null;
    // Composite reliability: 60% attendance + 40% punctuality — identical to
    // the per-officer summary table, including its "no completed shifts →
    // punctuality defaults to 100" convention, so the trend line for a week
    // always matches what the summary would report for that same week.
    // onTimeRate itself stays null in the payload to mark the missing signal.
    const reliabilityScore =
      attendanceRate === null
        ? null
        : Math.round((0.6 * attendanceRate + 0.4 * (onTimeRate ?? 100)) * 10) / 10;
    points.push({
      bucket,
      weekStart: monday.toISOString().slice(0, 10),
      shiftsAssigned: r.shiftsAssigned,
      shiftsCompleted: r.shiftsCompleted,
      noShows: r.noShows,
      hoursWorked: Math.round(r.hoursWorked * 10) / 10,
      attendanceRate,
      punctualityEligible: r.shiftsCompleted,
      onTimeRate,
      reliabilityScore,
    });
  }

  res.json({
    userId: user.id,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    weeks,
    points,
  });
});

// ---------- downloads -------------------------------------------------

/** Same leading-character guard the Exports center / Pay Run CSV uses. */
function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r|]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

const money = (n: number) => n.toFixed(2);
const pctOrDash = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);

function buildCsv(params: Params, summary: AnalyticsSummary, officers: AnalyticsOfficerRow[]): string {
  const lines: string[] = [];
  lines.push(csvRow([`${brand.companyName} — Analytics`]));
  lines.push(csvRow(["Range", params.start, params.end]));
  if (params.clientId) lines.push(csvRow(["Client filter", params.clientId]));
  lines.push("");
  lines.push(csvRow(["Summary metric", "Value"]));
  lines.push(csvRow(["Revenue (USD)", money(summary.revenue)]));
  lines.push(csvRow(["Labor cost (USD)", money(summary.laborCost)]));
  lines.push(csvRow(["P&L (USD)", money(summary.pnl)]));
  lines.push(csvRow(["Margin %", summary.marginPct == null ? "" : summary.marginPct.toFixed(1)]));
  lines.push(csvRow(["Hours worked", summary.hoursWorked.toFixed(2)]));
  lines.push(csvRow(["Hours scheduled", summary.hoursScheduled.toFixed(2)]));
  lines.push(csvRow(["Coverage %", summary.coveragePct == null ? "" : summary.coveragePct.toFixed(1)]));
  lines.push(csvRow(["No-shows", summary.noShows]));
  lines.push(csvRow(["Unfilled shifts", summary.unfilledShifts]));
  lines.push(csvRow(["Incidents (total)", summary.incidents.total]));
  lines.push(csvRow(["Incidents low/medium/high/critical", `${summary.incidents.low}/${summary.incidents.medium}/${summary.incidents.high}/${summary.incidents.critical}`]));
  lines.push(csvRow(["Incidents open/resolved", `${summary.incidents.open}/${summary.incidents.resolved}`]));
  lines.push("");
  lines.push(csvRow(["Week of", "Revenue", "Labor cost", "P&L", "Hours worked", "Incidents"]));
  for (const w of summary.weeklyTrend) {
    lines.push(csvRow([w.weekStart, money(w.revenue), money(w.laborCost), money(w.pnl), w.hoursWorked.toFixed(2), w.incidentCount]));
  }
  lines.push("");
  lines.push(csvRow(["Site", "Client", "Revenue", "Labor cost", "P&L", "Hours worked", "Coverage %"]));
  for (const s of summary.sites) {
    lines.push(csvRow([s.siteName, s.clientName ?? "", money(s.revenue), money(s.laborCost), money(s.pnl), s.hoursWorked.toFixed(2), s.coveragePct == null ? "" : s.coveragePct.toFixed(1)]));
  }
  lines.push("");
  lines.push(csvRow(["Officer", "Hours worked", "Shifts completed", "Incidents filed", "Punctuality %"]));
  for (const o of officers) {
    lines.push(csvRow([o.name, o.hoursWorked.toFixed(2), o.shiftsCompleted, o.incidentsFiled, o.punctualityPct == null ? "" : o.punctualityPct.toFixed(1)]));
  }
  lines.push("");
  lines.push(csvRow(["Note", "Revenue and labor cost match invoicing/payroll rules, including the 1.5x federal-holiday premium."]));
  return lines.join("\r\n");
}

const PDF_MARGIN = 40;

function pdfTable(
  doc: PDFKit.PDFDocument,
  title: string,
  headers: string[],
  widths: number[],
  rows: string[][],
): void {
  const bottom = doc.page.height - PDF_MARGIN - 20;
  if (doc.y + 60 > bottom) doc.addPage();
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111").text(title, PDF_MARGIN);
  doc.moveDown(0.3);
  const drawRow = (cells: string[], bold: boolean, zebra: boolean) => {
    if (doc.y + 16 > bottom) {
      doc.addPage();
      doc.y = PDF_MARGIN;
    }
    const y = doc.y;
    if (zebra) {
      doc.rect(PDF_MARGIN, y - 2, widths.reduce((a, b) => a + b, 0), 15).fill("#f4f1ea");
    }
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor("#222222");
    let x = PDF_MARGIN;
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i] ?? "", x + 2, y, { width: (widths[i] ?? 60) - 4, lineBreak: false });
      x += widths[i] ?? 60;
    }
    doc.y = y + 15;
  };
  drawRow(headers, true, false);
  let zebra = false;
  for (const r of rows) {
    drawRow(r, false, zebra);
    zebra = !zebra;
  }
}

function renderAnalyticsPdf(
  res: Response,
  params: Params,
  summary: AnalyticsSummary,
  officers: AnalyticsOfficerRow[],
): void {
  const doc = new PDFDocument({ size: "LETTER", margin: PDF_MARGIN });
  const filename = `analytics-${params.start}-to-${params.end}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const belowHeader = drawBrandHeader(doc, `Analytics — ${params.start} to ${params.end}`);
  doc.y = belowHeader + 16;

  const kpis: [string, string][] = [
    ["Revenue", `$${money(summary.revenue)}`],
    ["Labor cost", `$${money(summary.laborCost)}`],
    ["P&L", `$${money(summary.pnl)}`],
    ["Margin", pctOrDash(summary.marginPct)],
    ["Hours worked", summary.hoursWorked.toFixed(2)],
    ["Hours scheduled", summary.hoursScheduled.toFixed(2)],
    ["Coverage", pctOrDash(summary.coveragePct)],
    ["No-shows", String(summary.noShows)],
    ["Unfilled shifts", String(summary.unfilledShifts)],
    ["Incidents", String(summary.incidents.total)],
  ];
  const colW = (doc.page.width - PDF_MARGIN * 2) / 5;
  let x = PDF_MARGIN;
  let rowY = doc.y;
  kpis.forEach(([label, value], i) => {
    if (i > 0 && i % 5 === 0) {
      rowY += 40;
      x = PDF_MARGIN;
    }
    doc.font("Helvetica").fontSize(8).fillColor("#666666").text(label, x, rowY, { width: colW - 6, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111111").text(value, x, rowY + 11, { width: colW - 6, lineBreak: false });
    x += colW;
  });
  doc.y = rowY + 44;

  pdfTable(
    doc,
    "Weekly trend",
    ["Week of", "Revenue", "Labor cost", "P&L", "Hours", "Incidents"],
    [90, 90, 90, 90, 80, 70],
    summary.weeklyTrend.map((w) => [w.weekStart, `$${money(w.revenue)}`, `$${money(w.laborCost)}`, `$${money(w.pnl)}`, w.hoursWorked.toFixed(1), String(w.incidentCount)]),
  );
  pdfTable(
    doc,
    "Sites",
    ["Site", "Client", "Revenue", "P&L", "Hours", "Coverage"],
    [130, 110, 80, 80, 60, 70],
    summary.sites.map((s) => [s.siteName, s.clientName ?? "—", `$${money(s.revenue)}`, `$${money(s.pnl)}`, s.hoursWorked.toFixed(1), pctOrDash(s.coveragePct)]),
  );
  pdfTable(
    doc,
    "Officer performance",
    ["Officer", "Hours", "Shifts completed", "Incidents filed", "Punctuality"],
    [160, 80, 110, 100, 80],
    officers.map((o) => [o.name, o.hoursWorked.toFixed(1), String(o.shiftsCompleted), String(o.incidentsFiled), pctOrDash(o.punctualityPct)]),
  );

  doc.moveDown(1);
  doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#777777").text(
    "Revenue and labor cost match invoicing/payroll rules, including the 1.5\u00d7 federal-holiday premium.",
    PDF_MARGIN,
  );
  doc.end();
}

router.post("/admin/analytics/export-csv", requireAdmin, exportLimiter, async (req, res): Promise<void> => {
  const range = resolveRange(req.body, res);
  if (!range) return;
  const params = paramsSchema.parse(req.body);
  try {
    const [summary, officers] = await Promise.all([
      computeAnalyticsSummary(range),
      computeAnalyticsOfficers(range),
    ]);
    const csv = buildCsv(params, summary, officers);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${params.start}-to-${params.end}.csv"`);
    res.locals["auditMetadata"] = { format: "csv", start: params.start, end: params.end, clientId: params.clientId ?? null };
    res.status(200).send(csv);
  } catch (err) {
    logger.error({ err }, "[analytics] csv export failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not build CSV." });
  }
});

router.post("/admin/analytics/export-pdf", requireAdmin, exportLimiter, async (req, res): Promise<void> => {
  const range = resolveRange(req.body, res);
  if (!range) return;
  const params = paramsSchema.parse(req.body);
  try {
    const [summary, officers] = await Promise.all([
      computeAnalyticsSummary(range),
      computeAnalyticsOfficers(range),
    ]);
    res.locals["auditMetadata"] = { format: "pdf", start: params.start, end: params.end, clientId: params.clientId ?? null };
    renderAnalyticsPdf(res, params, summary, officers);
  } catch (err) {
    logger.error({ err }, "[analytics] pdf export failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error", message: "Could not build PDF." });
    } else {
      res.end();
    }
  }
});

export default router;
