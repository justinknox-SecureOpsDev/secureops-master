import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, asc, desc, eq, gte, lte, sql, max, type SQL } from "drizzle-orm";
import PDFDocument from "pdfkit";
import {
  db,
  shiftsTable,
  sitesTable,
  clientsTable,
  timeEntriesTable,
  payrollEntriesTable,
  incidentsTable,
  usersTable,
  employeesTable,
  applicationsTable,
  licensesTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { exportLimiter } from "../middlewares/rateLimit";
import { logger } from "../lib/logger";
import { brand as _brand } from "../lib/brandConfig";
import { isFeatureEnabled, requireFeature, type FeatureKey } from "../lib/features";

const router: IRouter = Router();
router.use("/admin/exports", requireFeature("exports"));

// -----------------------------------------------------------------------
// Exports center
//
// Admin-only "ad-hoc reporting" surface. Six datasets, a small set of
// shared filters (date range, site, client, officer, status), three
// outputs: JSON preview (≤20 sample rows + count), CSV download, PDF
// download. Every dataset's rendering is centralised in DATASETS below
// so the routes stay tiny.
//
// Safety boundaries:
//   - requireAdmin gates every endpoint.
//   - exportLimiter caps a single admin to ~20 exports/hr.
//   - PDF is capped at MAX_PDF_ROWS (10k) — bigger filters return 413
//     and the admin is asked to narrow the range or use CSV instead.
//   - CSV cells are escaped with the same leading-character guard the
//     Pay Run export uses (=, +, -, @, |, tab, CR) so Excel/Sheets
//     don't auto-execute injected formulas.
//   - The audit-log middleware classifies these paths as
//     exports.preview / exports.csv / exports.pdf and persists the
//     request body (dataset + filters) per call.
// -----------------------------------------------------------------------

const DATASET_IDS = [
  "shifts",
  "time_entries",
  "payroll_entries",
  "incidents",
  "officers",
  "applications",
] as const;
type DatasetId = (typeof DATASET_IDS)[number];

const filtersSchema = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    siteId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
    status: z.string().min(1).max(64).optional(),
  })
  .strict()
  .default({});

const requestSchema = z.object({
  dataset: z.enum(DATASET_IDS),
  filters: filtersSchema,
});
type ExportFilters = z.infer<typeof filtersSchema>;

// Rows are rendered as plain arrays of primitives — keeps CSV/PDF
// downstream code uniform regardless of dataset shape.
type Cell = string | number | null;
type DatasetResult = {
  columns: string[];
  rows: Cell[][];
};
type DatasetBuilder = (filters: ExportFilters, opts: { limit?: number }) => Promise<DatasetResult>;
type DatasetCounter = (filters: ExportFilters) => Promise<number>;
type Dataset = {
  id: DatasetId;
  label: string;
  build: DatasetBuilder;
  count: DatasetCounter;
};

const MAX_PDF_ROWS = 10_000;
const PREVIEW_SAMPLE_ROWS = 20;
// Belt-and-braces hard ceiling on CSV row count so a runaway filter
// can't trickle gigabytes through the response. 200k rows ≈ 30 MB CSV.
const MAX_CSV_ROWS = 200_000;

// ---------- helpers --------------------------------------------------

/**
 * CSV cell escaping. Identical contract to the Pay Run export:
 *   - Wrap in quotes if the value contains `,`, `"`, newline, tab, or CR.
 *   - Double up embedded quotes.
 *   - Defang leading `=`, `+`, `-`, `@`, `|`, tab, CR by prefixing `'`.
 *     (Excel / Sheets treat these as formula starters.)
 */
function csvEscape(value: Cell): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (s.length > 0 && /^[=+\-@|\t\r]/.test(s)) {
    s = "'" + s;
  }
  if (/[",\n\r\t]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(columns: string[], rows: Cell[][]): string {
  const out: string[] = [];
  out.push(columns.map((c) => csvEscape(c)).join(","));
  for (const row of rows) {
    out.push(row.map((v) => csvEscape(v)).join(","));
  }
  // CRLF — Excel-friendliest line ending.
  return out.join("\r\n") + "\r\n";
}

function parseDateBound(raw: string | undefined, end: boolean): Date | null {
  if (!raw) return null;
  // Accept either YYYY-MM-DD or full ISO. For date-only inputs we
  // expand to [00:00, 23:59:59.999] in UTC so the user's intent
  // ("everything on that day") matches a timestamp column.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + (end ? "T23:59:59.999Z" : "T00:00:00.000Z"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function fmtMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

// ---------- dataset builders ----------------------------------------

const shiftsDataset: Dataset = {
  id: "shifts",
  label: "Shifts",
  count: async (f) => {
    const where = shiftsWhere(f);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(shiftsTable)
      .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
      .where(where);
    return r?.n ?? 0;
  },
  build: async (f, opts) => {
    const where = shiftsWhere(f);
    const limit = opts.limit ?? MAX_CSV_ROWS;
    const rows = await db
      .select({
        id: shiftsTable.id,
        title: shiftsTable.title,
        siteName: sitesTable.name,
        clientName: clientsTable.name,
        startTime: shiftsTable.startTime,
        endTime: shiftsTable.endTime,
        headcount: shiftsTable.headcount,
        requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
        payRate: shiftsTable.payRate,
        billRate: shiftsTable.billRate,
        status: shiftsTable.status,
        isRepeat: shiftsTable.isRepeat,
      })
      .from(shiftsTable)
      .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
      .leftJoin(clientsTable, eq(clientsTable.id, sitesTable.clientId))
      .where(where)
      .orderBy(desc(shiftsTable.startTime))
      .limit(limit);

    return {
      columns: [
        "Shift ID", "Title", "Site", "Client",
        "Start (UTC)", "End (UTC)",
        "Headcount", "Min License", "Pay Rate", "Bill Rate",
        "Status", "Repeat",
      ],
      rows: rows.map((r) => [
        r.id,
        r.title,
        r.siteName ?? "",
        r.clientName ?? "",
        fmtDateTime(r.startTime),
        fmtDateTime(r.endTime),
        r.headcount,
        r.requiredLicenseLevel,
        fmtMoney(r.payRate),
        fmtMoney(r.billRate),
        r.status,
        r.isRepeat ? "yes" : "no",
      ]),
    };
  },
};

function shiftsWhere(f: ExportFilters): SQL | undefined {
  const conds: SQL[] = [];
  const from = parseDateBound(f.from, false);
  const to = parseDateBound(f.to, true);
  if (from) conds.push(gte(shiftsTable.startTime, from));
  if (to) conds.push(lte(shiftsTable.startTime, to));
  if (f.siteId) conds.push(eq(shiftsTable.siteId, f.siteId));
  if (f.clientId) conds.push(eq(sitesTable.clientId, f.clientId));
  if (f.status) conds.push(eq(shiftsTable.status, f.status));
  return conds.length ? and(...conds) : undefined;
}

const timeEntriesDataset: Dataset = {
  id: "time_entries",
  label: "Time Entries",
  count: async (f) => {
    const where = timeEntriesWhere(f);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeEntriesTable)
      .leftJoin(sitesTable, eq(sitesTable.id, timeEntriesTable.siteId))
      .where(where);
    return r?.n ?? 0;
  },
  build: async (f, opts) => {
    const where = timeEntriesWhere(f);
    const limit = opts.limit ?? MAX_CSV_ROWS;
    const rows = await db
      .select({
        id: timeEntriesTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        siteName: sitesTable.name,
        clientName: clientsTable.name,
        clockInTime: timeEntriesTable.clockInTime,
        clockOutTime: timeEntriesTable.clockOutTime,
        hoursWorked: timeEntriesTable.hoursWorked,
        approvalStatus: timeEntriesTable.approvalStatus,
        isVerified: timeEntriesTable.isVerified,
      })
      .from(timeEntriesTable)
      .leftJoin(usersTable, eq(usersTable.id, timeEntriesTable.employeeId))
      .leftJoin(sitesTable, eq(sitesTable.id, timeEntriesTable.siteId))
      .leftJoin(clientsTable, eq(clientsTable.id, sitesTable.clientId))
      .where(where)
      .orderBy(desc(timeEntriesTable.clockInTime))
      .limit(limit);

    return {
      columns: [
        "Entry ID", "Officer", "Email", "Site", "Client",
        "Clock In (UTC)", "Clock Out (UTC)", "Hours",
        "Approval", "Verified",
      ],
      rows: rows.map((r) => [
        r.id,
        [r.firstName, r.lastName].filter(Boolean).join(" "),
        r.email ?? "",
        r.siteName ?? "",
        r.clientName ?? "",
        fmtDateTime(r.clockInTime),
        fmtDateTime(r.clockOutTime),
        r.hoursWorked === null || r.hoursWorked === undefined
          ? ""
          : Number(r.hoursWorked).toFixed(2),
        r.approvalStatus,
        r.isVerified ? "yes" : "no",
      ]),
    };
  },
};

function timeEntriesWhere(f: ExportFilters): SQL | undefined {
  const conds: SQL[] = [];
  const from = parseDateBound(f.from, false);
  const to = parseDateBound(f.to, true);
  if (from) conds.push(gte(timeEntriesTable.clockInTime, from));
  if (to) conds.push(lte(timeEntriesTable.clockInTime, to));
  if (f.siteId) conds.push(eq(timeEntriesTable.siteId, f.siteId));
  if (f.clientId) conds.push(eq(sitesTable.clientId, f.clientId));
  if (f.employeeId) conds.push(eq(timeEntriesTable.employeeId, f.employeeId));
  if (f.status) conds.push(eq(timeEntriesTable.approvalStatus, f.status));
  return conds.length ? and(...conds) : undefined;
}

const payrollDataset: Dataset = {
  id: "payroll_entries",
  label: "Payroll Entries",
  count: async (f) => {
    const where = payrollWhere(f);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollEntriesTable)
      .leftJoin(sitesTable, eq(sitesTable.id, payrollEntriesTable.siteId))
      .where(where);
    return r?.n ?? 0;
  },
  build: async (f, opts) => {
    const where = payrollWhere(f);
    const limit = opts.limit ?? MAX_CSV_ROWS;
    const rows = await db
      .select({
        id: payrollEntriesTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        siteName: sitesTable.name,
        clientName: clientsTable.name,
        periodStart: payrollEntriesTable.periodStart,
        periodEnd: payrollEntriesTable.periodEnd,
        totalHours: payrollEntriesTable.totalHours,
        hourlyRate: payrollEntriesTable.hourlyRate,
        grossPay: payrollEntriesTable.grossPay,
        tax: payrollEntriesTable.tax,
        netPay: payrollEntriesTable.netPay,
        status: payrollEntriesTable.status,
        paidMethod: payrollEntriesTable.paidMethod,
        paymentReference: payrollEntriesTable.paymentReference,
        paidAt: payrollEntriesTable.paidAt,
      })
      .from(payrollEntriesTable)
      .leftJoin(usersTable, eq(usersTable.id, payrollEntriesTable.employeeId))
      .leftJoin(sitesTable, eq(sitesTable.id, payrollEntriesTable.siteId))
      .leftJoin(clientsTable, eq(clientsTable.id, sitesTable.clientId))
      .where(where)
      .orderBy(desc(payrollEntriesTable.periodStart))
      .limit(limit);

    return {
      columns: [
        "Entry ID", "Officer", "Email", "Site", "Client",
        "Period Start", "Period End",
        "Hours", "Rate", "Gross", "Tax", "Net",
        "Status", "Method", "Reference", "Paid At (UTC)",
      ],
      rows: rows.map((r) => [
        r.id,
        [r.firstName, r.lastName].filter(Boolean).join(" "),
        r.email ?? "",
        r.siteName ?? "",
        r.clientName ?? "",
        fmtDate(r.periodStart),
        fmtDate(r.periodEnd),
        Number(r.totalHours).toFixed(2),
        fmtMoney(r.hourlyRate),
        fmtMoney(r.grossPay),
        // 1099 contractors — no tax is withheld; net always equals gross.
        // Normalise on export so any legacy row stored with withholding still
        // reports full gross.
        fmtMoney("0"),
        fmtMoney(r.grossPay),
        r.status,
        r.paidMethod ?? "",
        r.paymentReference ?? "",
        fmtDateTime(r.paidAt),
      ]),
    };
  },
};

function payrollWhere(f: ExportFilters): SQL | undefined {
  const conds: SQL[] = [];
  // periodStart is a DATE column — bound by ISO date strings only.
  if (f.from) {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(f.from);
    if (m) conds.push(gte(payrollEntriesTable.periodStart, m[0]));
  }
  if (f.to) {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(f.to);
    if (m) conds.push(lte(payrollEntriesTable.periodStart, m[0]));
  }
  if (f.siteId) conds.push(eq(payrollEntriesTable.siteId, f.siteId));
  if (f.clientId) conds.push(eq(sitesTable.clientId, f.clientId));
  if (f.employeeId) conds.push(eq(payrollEntriesTable.employeeId, f.employeeId));
  if (f.status) conds.push(eq(payrollEntriesTable.status, f.status));
  return conds.length ? and(...conds) : undefined;
}

const incidentsDataset: Dataset = {
  id: "incidents",
  label: "Incidents",
  count: async (f) => {
    const where = incidentsWhere(f);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(incidentsTable)
      .leftJoin(shiftsTable, eq(shiftsTable.id, incidentsTable.shiftId))
      .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
      .where(where);
    return r?.n ?? 0;
  },
  build: async (f, opts) => {
    const where = incidentsWhere(f);
    const limit = opts.limit ?? MAX_CSV_ROWS;
    const rows = await db
      .select({
        id: incidentsTable.id,
        title: incidentsTable.title,
        severity: incidentsTable.severity,
        status: incidentsTable.status,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        siteName: sitesTable.name,
        clientName: clientsTable.name,
        occurredAt: incidentsTable.occurredAt,
        resolvedAt: incidentsTable.resolvedAt,
        locationDescription: incidentsTable.locationDescription,
      })
      .from(incidentsTable)
      .leftJoin(usersTable, eq(usersTable.id, incidentsTable.employeeId))
      .leftJoin(shiftsTable, eq(shiftsTable.id, incidentsTable.shiftId))
      .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
      .leftJoin(clientsTable, eq(clientsTable.id, sitesTable.clientId))
      .where(where)
      .orderBy(desc(incidentsTable.occurredAt))
      .limit(limit);

    return {
      columns: [
        "Incident ID", "Title", "Severity", "Status",
        "Officer", "Email", "Site", "Client",
        "Occurred (UTC)", "Resolved (UTC)", "Location",
      ],
      rows: rows.map((r) => [
        r.id,
        r.title,
        r.severity,
        r.status,
        [r.firstName, r.lastName].filter(Boolean).join(" "),
        r.email ?? "",
        r.siteName ?? "",
        r.clientName ?? "",
        fmtDateTime(r.occurredAt),
        fmtDateTime(r.resolvedAt),
        r.locationDescription ?? "",
      ]),
    };
  },
};

function incidentsWhere(f: ExportFilters): SQL | undefined {
  const conds: SQL[] = [];
  const from = parseDateBound(f.from, false);
  const to = parseDateBound(f.to, true);
  if (from) conds.push(gte(incidentsTable.occurredAt, from));
  if (to) conds.push(lte(incidentsTable.occurredAt, to));
  if (f.employeeId) conds.push(eq(incidentsTable.employeeId, f.employeeId));
  if (f.siteId) conds.push(eq(shiftsTable.siteId, f.siteId));
  if (f.clientId) conds.push(eq(sitesTable.clientId, f.clientId));
  if (f.status) conds.push(eq(incidentsTable.status, f.status));
  return conds.length ? and(...conds) : undefined;
}

const officersDataset: Dataset = {
  id: "officers",
  label: "Officers",
  count: async (f) => {
    const where = officersWhere(f);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(where);
    return r?.n ?? 0;
  },
  build: async (f, opts) => {
    const where = officersWhere(f);
    const limit = opts.limit ?? MAX_CSV_ROWS;
    // Pull the max unexpired license level per officer in a single
    // aggregate sub-query keyed by employeeId.
    const today = new Date().toISOString().slice(0, 10);
    const maxLevels = db
      .select({
        employeeId: licensesTable.employeeId,
        lvl: max(licensesTable.level).as("max_level"),
      })
      .from(licensesTable)
      .where(gte(licensesTable.expiryDate, today))
      .groupBy(licensesTable.employeeId)
      .as("max_levels");
    const rows = await db
      .select({
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        phone: usersTable.phoneNumber,
        status: usersTable.status,
        createdAt: usersTable.createdAt,
        firstLoginAt: usersTable.firstLoginAt,
        lastLoginAt: usersTable.lastLoginAt,
        hourlyRate: employeesTable.hourlyRate,
        maxLicenseLevel: maxLevels.lvl,
      })
      .from(usersTable)
      .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
      .leftJoin(maxLevels, eq(maxLevels.employeeId, usersTable.id))
      .where(where)
      .orderBy(asc(usersTable.lastName), asc(usersTable.firstName))
      .limit(limit);

    return {
      columns: [
        "Officer ID", "First Name", "Last Name", "Email", "Phone",
        "Status", "Hourly Rate", "Max License Level",
        "Created (UTC)", "First Login (UTC)", "Last Login (UTC)",
      ],
      rows: rows.map((r) => [
        r.id,
        r.firstName ?? "",
        r.lastName ?? "",
        r.email ?? "",
        r.phone ?? "",
        r.status ?? "",
        fmtMoney(r.hourlyRate),
        r.maxLicenseLevel ?? "",
        fmtDateTime(r.createdAt),
        fmtDateTime(r.firstLoginAt),
        fmtDateTime(r.lastLoginAt),
      ]),
    };
  },
};

function officersWhere(f: ExportFilters): SQL | undefined {
  const conds: SQL[] = [eq(usersTable.role, "employee")];
  const from = parseDateBound(f.from, false);
  const to = parseDateBound(f.to, true);
  if (from) conds.push(gte(usersTable.createdAt, from));
  if (to) conds.push(lte(usersTable.createdAt, to));
  if (f.employeeId) conds.push(eq(usersTable.id, f.employeeId));
  if (f.status) conds.push(eq(usersTable.status, f.status));
  return and(...conds);
}

const applicationsDataset: Dataset = {
  id: "applications",
  label: "Applications",
  count: async (f) => {
    const where = applicationsWhere(f);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(applicationsTable)
      .where(where);
    return r?.n ?? 0;
  },
  build: async (f, opts) => {
    const where = applicationsWhere(f);
    const limit = opts.limit ?? MAX_CSV_ROWS;
    const rows = await db
      .select({
        id: applicationsTable.id,
        status: applicationsTable.status,
        firstName: applicationsTable.firstName,
        lastName: applicationsTable.lastName,
        email: applicationsTable.email,
        phone: applicationsTable.phone,
        city: applicationsTable.city,
        state: applicationsTable.state,
        zip: applicationsTable.zip,
        siaLicenseLevel: applicationsTable.siaLicenseLevel,
        yearsExperience: applicationsTable.yearsExperience,
        createdAt: applicationsTable.createdAt,
        reviewedAt: applicationsTable.reviewedAt,
      })
      .from(applicationsTable)
      .where(where)
      .orderBy(desc(applicationsTable.createdAt))
      .limit(limit);

    return {
      columns: [
        "Application ID", "Status", "First Name", "Last Name",
        "Email", "Phone", "City", "State", "ZIP",
        "License Level", "Years Experience",
        "Submitted (UTC)", "Reviewed (UTC)",
      ],
      rows: rows.map((r) => [
        r.id,
        r.status,
        r.firstName,
        r.lastName,
        r.email,
        r.phone,
        r.city ?? "",
        r.state ?? "",
        r.zip ?? "",
        r.siaLicenseLevel ?? "",
        r.yearsExperience ?? "",
        fmtDateTime(r.createdAt),
        fmtDateTime(r.reviewedAt),
      ]),
    };
  },
};

function applicationsWhere(f: ExportFilters): SQL | undefined {
  const conds: SQL[] = [];
  const from = parseDateBound(f.from, false);
  const to = parseDateBound(f.to, true);
  if (from) conds.push(gte(applicationsTable.createdAt, from));
  if (to) conds.push(lte(applicationsTable.createdAt, to));
  if (f.status) conds.push(eq(applicationsTable.status, f.status));
  return conds.length ? and(...conds) : undefined;
}

const DATASETS: Record<DatasetId, Dataset> = {
  shifts: shiftsDataset,
  time_entries: timeEntriesDataset,
  payroll_entries: payrollDataset,
  incidents: incidentsDataset,
  officers: officersDataset,
  applications: applicationsDataset,
};

// Cross-domain feature gating. Some export datasets pull data straight out
// of a feature-gated domain (payroll, incidents, HR). The dedicated routers
// (payroll/invoices/incidents/applications) already 403 when their flag is
// off, but the Exports center is its own `exports`-gated router — so without
// this map an admin on a plan that disables payroll could still pull every
// payroll row out via /admin/exports. Map each dataset to the feature whose
// data it surfaces; `null` means it's core (shifts/time-entries/officers ship
// in every tier). A disabled feature here returns the same feature-disabled
// 403 the underlying router would, so the data never leaks through exports.
const DATASET_FEATURE: Record<DatasetId, FeatureKey | null> = {
  shifts: null,
  time_entries: null,
  payroll_entries: "payroll",
  incidents: "incidents",
  officers: null,
  applications: "hr",
};

/**
 * If the requested dataset belongs to a disabled feature, write the
 * feature-disabled 403 (same shape as `requireFeature`) and return true so
 * the caller can short-circuit. Returns false when the dataset is allowed.
 */
function blockedByFeature(ds: Dataset, res: import("express").Response): boolean {
  const feature = DATASET_FEATURE[ds.id];
  if (feature && !isFeatureEnabled(feature)) {
    res.status(403).json({
      error: "Forbidden",
      message: `Feature '${feature}' is not enabled in this deployment.`,
      feature,
    });
    return true;
  }
  return false;
}

// ---------- PDF render ----------------------------------------------

const NAVY  = _brand.colorNavy;
const GOLD  = _brand.colorGold;
const CREAM = _brand.colorCream;
const MUTED = "#666666";
const TEXT = "#1a1a1a";

function fmtFilterValue(v: string | undefined): string | null {
  if (!v) return null;
  return v;
}

function renderPdf(
  res: import("express").Response,
  dataset: Dataset,
  filters: ExportFilters,
  result: DatasetResult,
): void {
  const filename = `wcsg-${dataset.id.replace(/_/g, "-")}-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margins: { top: 56, bottom: 48, left: 36, right: 36 },
    info: {
      Title: `${_brand.shortName} Export — ${dataset.label}`,
      Author: _brand.companyName,
      Subject: `Export of ${dataset.label} (${result.rows.length} rows)`,
      CreationDate: new Date(),
    },
    bufferPages: true,
  });
  doc.pipe(res);

  // Header band on the first page; subsequent pages get a thinner
  // re-statement via pageAdded so the brand stays on every page.
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const usableLeft = 36;
  const usableRight = pageWidth - 36;
  const usableWidth = usableRight - usableLeft;

  const drawHeader = (firstPage: boolean): void => {
    doc.save();
    doc.rect(0, 0, doc.page.width, firstPage ? 64 : 36).fill(NAVY);
    doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(firstPage ? 16 : 11)
      .text(_brand.companyName, usableLeft, firstPage ? 18 : 11);
    if (firstPage) {
      doc.fillColor(CREAM).font("Helvetica").fontSize(9)
        .text(`Export — ${dataset.label}`, usableLeft, 42);
    }
    doc.rect(0, firstPage ? 64 : 36, doc.page.width, 2).fill(GOLD);
    doc.restore();
  };

  const drawFooter = (): void => {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(
        `Generated ${new Date().toLocaleString()} · ${_brand.companyName} · Confidential · page ${i + 1} of ${range.count}`,
        usableLeft, pageHeight - 24,
        { width: usableWidth, align: "center", lineBreak: false },
      );
    }
  };

  doc.on("pageAdded", () => {
    drawHeader(false);
    doc.y = 48;
  });

  drawHeader(true);
  doc.y = 80;

  // Filters summary block.
  const summaryParts: string[] = [];
  const addFilter = (k: string, v: string | null) => {
    if (v !== null && v !== "") summaryParts.push(`${k}: ${v}`);
  };
  addFilter("From", fmtFilterValue(filters.from));
  addFilter("To", fmtFilterValue(filters.to));
  addFilter("Site", fmtFilterValue(filters.siteId));
  addFilter("Client", fmtFilterValue(filters.clientId));
  addFilter("Officer", fmtFilterValue(filters.employeeId));
  addFilter("Status", fmtFilterValue(filters.status));
  doc.fillColor(MUTED).font("Helvetica").fontSize(9)
    .text(
      summaryParts.length ? `Filters — ${summaryParts.join("  ·  ")}` : "Filters — (none)",
      usableLeft, doc.y,
      { width: usableWidth, lineBreak: true },
    );
  doc.fillColor(TEXT).font("Helvetica").fontSize(9)
    .text(`Rows: ${result.rows.length.toLocaleString()}`, usableLeft, doc.y + 2);
  doc.moveDown(0.5);

  // Table — equal-width columns. Truncate over-long cells with an
  // ellipsis so a single huge "notes" string never pushes a row off
  // the page. We pre-trim everything to ~80 chars/cell which fits
  // comfortably in landscape at fontSize 8.
  const columns = result.columns;
  const colCount = columns.length;
  const colWidth = usableWidth / Math.max(colCount, 1);
  const rowHeight = 16;
  const headerHeight = 18;

  const truncate = (s: string, max: number): string => {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + "…";
  };
  const cellMaxChars = Math.max(8, Math.floor(colWidth / 4));

  const drawHeaderRow = (yTop: number): void => {
    doc.save();
    doc.rect(usableLeft, yTop, usableWidth, headerHeight).fill(NAVY);
    doc.fillColor(CREAM).font("Helvetica-Bold").fontSize(8);
    for (let i = 0; i < colCount; i++) {
      doc.text(
        truncate(columns[i] ?? "", cellMaxChars),
        usableLeft + i * colWidth + 4,
        yTop + 5,
        { width: colWidth - 8, lineBreak: false, ellipsis: true },
      );
    }
    doc.restore();
  };

  let y = doc.y + 4;
  drawHeaderRow(y);
  y += headerHeight;

  let zebra = false;
  for (const row of result.rows) {
    if (y + rowHeight > pageHeight - 36) {
      doc.addPage();
      // pageAdded handler stamped the header — start under it.
      y = 48;
      drawHeaderRow(y);
      y += headerHeight;
      zebra = false;
    }
    if (zebra) {
      doc.save().rect(usableLeft, y, usableWidth, rowHeight).fill("#f6f1e3").restore();
    }
    doc.fillColor(TEXT).font("Helvetica").fontSize(8);
    for (let i = 0; i < colCount; i++) {
      const raw = row[i];
      const s = raw === null || raw === undefined ? "" : String(raw);
      doc.text(
        truncate(s, cellMaxChars),
        usableLeft + i * colWidth + 4,
        y + 4,
        { width: colWidth - 8, lineBreak: false, ellipsis: true },
      );
    }
    y += rowHeight;
    zebra = !zebra;
  }

  drawFooter();
  doc.end();
}

// ---------- routes ---------------------------------------------------

router.post("/admin/exports/preview", requireAdmin, exportLimiter, async (req, res): Promise<void> => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const ds = DATASETS[parsed.data.dataset];
  if (blockedByFeature(ds, res)) return;
  try {
    const [count, sample] = await Promise.all([
      ds.count(parsed.data.filters),
      ds.build(parsed.data.filters, { limit: PREVIEW_SAMPLE_ROWS }),
    ]);
    res.locals["auditMetadata"] = {
      dataset: ds.id,
      format: "preview",
      rowCount: count,
      sampleRows: sample.rows.length,
    };
    res.json({
      dataset: ds.id,
      label: ds.label,
      count,
      columns: sample.columns,
      sample: sample.rows,
      pdfRowLimit: MAX_PDF_ROWS,
      csvRowLimit: MAX_CSV_ROWS,
    });
  } catch (err) {
    logger.error({ err, dataset: ds.id }, "[exports] preview failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not build preview." });
  }
});

router.post("/admin/exports/csv", requireAdmin, exportLimiter, async (req, res): Promise<void> => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const ds = DATASETS[parsed.data.dataset];
  if (blockedByFeature(ds, res)) return;
  try {
    const count = await ds.count(parsed.data.filters);
    if (count > MAX_CSV_ROWS) {
      res.locals["auditMetadata"] = { dataset: ds.id, format: "csv", rowCount: count, exceededLimit: true, limit: MAX_CSV_ROWS };
      res.status(413).json({
        error: "Payload Too Large",
        message: `CSV export is capped at ${MAX_CSV_ROWS.toLocaleString()} rows; your filters match ${count.toLocaleString()}. Narrow the date range and try again.`,
        rowCount: count,
        limit: MAX_CSV_ROWS,
      });
      return;
    }
    const result = await ds.build(parsed.data.filters, { limit: MAX_CSV_ROWS });
    const csv = rowsToCsv(result.columns, result.rows);
    const filename = `wcsg-${ds.id.replace(/_/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // Tiny header so admins can confirm the row count without opening
    // the file. Audit log records the row count separately via res.locals.
    res.setHeader("X-Export-Row-Count", String(result.rows.length));
    res.locals["auditMetadata"] = { dataset: ds.id, format: "csv", rowCount: result.rows.length };
    res.status(200).send(csv);
  } catch (err) {
    logger.error({ err, dataset: ds.id }, "[exports] csv failed");
    res.status(500).json({ error: "Internal Server Error", message: "Could not build CSV." });
  }
});

router.post("/admin/exports/pdf", requireAdmin, exportLimiter, async (req, res): Promise<void> => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const ds = DATASETS[parsed.data.dataset];
  if (blockedByFeature(ds, res)) return;
  try {
    const count = await ds.count(parsed.data.filters);
    if (count > MAX_PDF_ROWS) {
      res.locals["auditMetadata"] = { dataset: ds.id, format: "pdf", rowCount: count, exceededLimit: true, limit: MAX_PDF_ROWS };
      res.status(413).json({
        error: "Payload Too Large",
        message: `PDF export is capped at ${MAX_PDF_ROWS.toLocaleString()} rows; your filters match ${count.toLocaleString()}. Narrow the date range or use CSV.`,
        rowCount: count,
        limit: MAX_PDF_ROWS,
      });
      return;
    }
    const result = await ds.build(parsed.data.filters, { limit: MAX_PDF_ROWS });
    res.setHeader("X-Export-Row-Count", String(result.rows.length));
    res.locals["auditMetadata"] = { dataset: ds.id, format: "pdf", rowCount: result.rows.length };
    renderPdf(res, ds, parsed.data.filters, result);
  } catch (err) {
    logger.error({ err, dataset: ds.id }, "[exports] pdf failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error", message: "Could not build PDF." });
    } else {
      res.end();
    }
  }
});

export default router;
