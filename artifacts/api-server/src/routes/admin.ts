import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql, desc, asc, ilike, or, and, inArray, type AnyColumn } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  siteRatesTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
  payrollEntriesTable,
  invoicesTable,
  incidentsTable,
  licensesTable,
  trainingCertificationsTable,
  subcontractorsTable,
  subcontractorCoisTable,
  subcontractorContractsTable,
  subcontractorInvoicesTable,
  insertSubcontractorSchema,
  insertSubcontractorCoiSchema,
  insertSubcontractorContractSchema,
  insertSubcontractorInvoiceSchema,
  passwordResetTokensTable,
  insertEmployeeSchema,
  insertClientSchema,
  insertSiteSchema,
  insertShiftSchema,
  insertShiftAssignmentSchema,
  insertTimeEntrySchema,
  insertPayrollEntrySchema,
  insertInvoiceSchema,
  insertIncidentSchema,
  insertLicenseSchema,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { sendEmail, renderPasswordResetEmail, renderInviteEmail } from "../lib/email";
import { disconnectUser } from "../lib/wsManager";
import { writeEmployeeFieldChanges } from "../lib/employeeChangeLog";
import { preparePreUpdateBody as prepareSitePreUpdate, maybeAutoGeocode as maybeAutoGeocodeSite } from "../lib/siteGeocode";
import { normalizePhoneToE164 } from "../lib/phone";
import { adminEditBreaksAutoSync } from "../lib/invoiceSync";

/**
 * Coerce a free-text phone field on an admin CRUD payload into E.164 in place.
 *
 * Mirrors the public application/onboarding normalizers so SMS-style flows
 * (emergency alerts, shift assignment, direct-message-officer, etc.) actually
 * dispatch. Admins routinely paste numbers in mixed formats — without this,
 * the SMS pipeline (which requires `+<8..15 digits>`) silently skips them.
 *
 * - `undefined` → left untouched (partial-update friendly).
 * - `null` / `""` → coerced to `null` so the column is cleared.
 * - Non-parseable text → returns an error string the caller surfaces as 400.
 */
function normalizePhoneFieldInPlace(
  body: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (!(key in body)) return null;
  const raw = body[key];
  if (raw === undefined) return null;
  if (raw === null || raw === "") {
    body[key] = null;
    return null;
  }
  if (typeof raw !== "string") {
    return `${label} must be text.`;
  }
  const norm = normalizePhoneToE164(raw);
  if (!norm) {
    return `${label} is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).`;
  }
  body[key] = norm;
  return null;
}

const router: IRouter = Router();

/**
 * Generic admin "spreadsheet" endpoints. Every supported table exposes:
 *   GET    /admin/tables/:table              list rows (paginated, sortable, searchable)
 *   POST   /admin/tables/:table              insert row (validated by drizzle-zod insert schema)
 *   PUT    /admin/tables/:table/:id          partial update
 *   DELETE /admin/tables/:table/:id          delete row
 *   POST   /admin/import/:table              bulk insert pre-mapped rows (used by Excel import)
 *
 * All writes are validated server-side. The browser portal never talks to the
 * DB directly — it always goes through these endpoints.
 */

type TableConfig = {
  table: any;
  insertSchema: z.ZodSchema<any>;
  /** Columns considered free-text searchable. */
  searchColumns: AnyColumn[];
  /** Column used for default ordering (typically createdAt desc). */
  orderBy: AnyColumn;
  /** Convert raw API JSON into the values drizzle expects (e.g. number -> string for numeric, ISO -> Date). */
  coerceWrite: (input: Record<string, unknown>) => Record<string, unknown>;
  /** Optional async hook before insert (e.g. hash password). Returns final values. */
  beforeInsert?: (
    values: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Whether the import endpoint is supported for this table. */
  importSupported: boolean;
  /** Human-readable label for error messages. */
  label: string;
};

// ---- coercers ---------------------------------------------------------------

function toStringOrNull(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}
function toDateOrNull(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
function toIntOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : Math.trunc(n);
}
function toBoolOrNull(v: unknown): boolean | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

function pick<T extends Record<string, unknown>>(
  src: T,
  keys: readonly string[],
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in src) out[k] = (src as any)[k];
  return out as Partial<T>;
}

// ---- Per-table coercers (numeric columns must be strings for drizzle pg) ----

const numericKeys = (...keys: string[]) => keys;

function applyNumericCoercion(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out = { ...input };
  for (const k of keys) {
    if (k in out) out[k] = toStringOrNull(out[k]);
  }
  return out;
}
function applyDateCoercion(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out = { ...input };
  for (const k of keys) {
    if (k in out) out[k] = toDateOrNull(out[k]);
  }
  return out;
}
function applyIntCoercion(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out = { ...input };
  for (const k of keys) {
    if (k in out) out[k] = toIntOrNull(out[k]);
  }
  return out;
}

// ---- Users (special — handles password hashing) ----------------------------

const insertUserAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).optional(),
  passwordHash: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["admin", "dispatcher", "employee"]).default("employee"),
  status: z.enum(["active", "inactive", "pending"]).default("active"),
  expoPushToken: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  smsOptIn: z.boolean().optional(),
});

const updateUserAdminSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(["admin", "dispatcher", "employee"]).optional(),
  status: z.enum(["active", "inactive", "pending"]).optional(),
  expoPushToken: z.string().nullable().optional(),
  // Editable contact + SMS opt-in. Without these in the allow-list the
  // strict zod parser silently strips them, so admin edits "disappear"
  // (the request succeeds but the field is never written).
  phoneNumber: z.string().nullable().optional(),
  smsOptIn: z.boolean().optional(),
});

// ---- Table registry ---------------------------------------------------------

const tables: Record<string, TableConfig> = {
  users: {
    table: usersTable,
    insertSchema: insertUserAdminSchema as unknown as z.ZodSchema<any>,
    searchColumns: [usersTable.email, usersTable.firstName, usersTable.lastName, usersTable.role],
    orderBy: usersTable.createdAt,
    coerceWrite: (v) => {
      const out = { ...v };
      const err = normalizePhoneFieldInPlace(out, "phoneNumber", "Phone number");
      if (err) throw Object.assign(new Error(err), { __badRequest: true });
      return out;
    },
    beforeInsert: async (v) => {
      const out: Record<string, unknown> = { ...v };
      if (out.password) {
        out.passwordHash = await bcrypt.hash(String(out.password), 10);
        delete out.password;
      }
      if (typeof out.email === "string") out.email = out.email.toLowerCase();
      if (!out.passwordHash) {
        // Generate a random unguessable hash so seeded users without a password can't log in.
        const placeholder = `disabled-${Math.random().toString(36).slice(2)}-${Date.now()}`;
        out.passwordHash = await bcrypt.hash(placeholder, 10);
      }
      return out;
    },
    importSupported: true,
    label: "User",
  },
  employees: {
    table: employeesTable,
    insertSchema: insertEmployeeSchema as unknown as z.ZodSchema<any>,
    searchColumns: [employeesTable.phone, employeesTable.address, employeesTable.siaLicenseNumber],
    orderBy: employeesTable.createdAt,
    coerceWrite: (v) => {
      let out = applyNumericCoercion(v, ["hourlyRate"]);
      out = applyIntCoercion(out, ["siaLicenseLevel", "yearsExperience"]);
      out = applyDateCoercion(out, ["dateOfBirth", "siaLicenseExpiry"]);
      // Normalize phone fields to E.164. Throws so the admin sees a clear
      // 400 (caught by the route handler) rather than silently storing a
      // value that SMS will later skip.
      for (const [key, label] of [
        ["phone", "Phone"],
        ["emergencyContactPhone", "Emergency contact phone"],
      ] as const) {
        const err = normalizePhoneFieldInPlace(out, key, label);
        if (err) throw Object.assign(new Error(err), { __badRequest: true });
      }
      return out;
    },
    importSupported: true,
    label: "Employee",
  },
  clients: {
    table: clientsTable,
    insertSchema: insertClientSchema as unknown as z.ZodSchema<any>,
    searchColumns: [clientsTable.name, clientsTable.contactName, clientsTable.contactEmail],
    orderBy: clientsTable.createdAt,
    coerceWrite: (v) => applyIntCoercion(v, ["paymentTermsDays"]),
    importSupported: true,
    label: "Client",
  },
  sites: {
    table: sitesTable,
    insertSchema: insertSiteSchema as unknown as z.ZodSchema<any>,
    searchColumns: [sitesTable.name, sitesTable.address],
    orderBy: sitesTable.createdAt,
    coerceWrite: (v) => applyNumericCoercion(v, ["locationLat", "locationLng", "defaultPayRate", "defaultBillRate", "geofenceRadiusMiles"]),
    importSupported: true,
    label: "Site",
  },
  shifts: {
    table: shiftsTable,
    insertSchema: insertShiftSchema as unknown as z.ZodSchema<any>,
    searchColumns: [shiftsTable.title, shiftsTable.clientName, shiftsTable.location],
    orderBy: shiftsTable.startTime,
    coerceWrite: (v) => {
      let out = applyNumericCoercion(v, [
        "locationLat",
        "locationLng",
        "payRate",
        "billRate",
        "hourlyRate",
        "billableRate",
      ]);
      out = applyDateCoercion(out, ["startTime", "endTime"]);
      out = applyIntCoercion(out, ["requiredLicenseLevel", "headcount"]);
      if (out.requiredLicenseLevel != null && ![1, 2, 3, 4].includes(Number(out.requiredLicenseLevel))) {
        throw Object.assign(new Error("requiredLicenseLevel must be 1, 2, 3, or 4"), { __badRequest: true });
      }
      return out;
    },
    importSupported: true,
    label: "Shift",
  },
  shift_assignments: {
    table: shiftAssignmentsTable,
    insertSchema: insertShiftAssignmentSchema as unknown as z.ZodSchema<any>,
    searchColumns: [shiftAssignmentsTable.status],
    orderBy: shiftAssignmentsTable.createdAt,
    coerceWrite: (v) => v,
    importSupported: true,
    label: "Shift assignment",
  },
  time_entries: {
    table: timeEntriesTable,
    insertSchema: insertTimeEntrySchema as unknown as z.ZodSchema<any>,
    searchColumns: [timeEntriesTable.approvalStatus, timeEntriesTable.notes],
    orderBy: timeEntriesTable.clockInTime,
    coerceWrite: (v) => {
      let out = applyDateCoercion(v, ["clockInTime", "clockOutTime", "approvedAt"]);
      out = applyNumericCoercion(out, [
        "clockInLat",
        "clockInLng",
        "clockOutLat",
        "clockOutLng",
        "hoursWorked",
      ]);
      return out;
    },
    importSupported: true,
    label: "Time entry",
  },
  payroll_entries: {
    table: payrollEntriesTable,
    insertSchema: insertPayrollEntrySchema as unknown as z.ZodSchema<any>,
    searchColumns: [payrollEntriesTable.status, payrollEntriesTable.notes],
    orderBy: payrollEntriesTable.periodStart,
    coerceWrite: (v) => {
      let out = applyDateCoercion(v, ["paidAt"]);
      out = applyNumericCoercion(out, ["totalHours", "hourlyRate", "grossPay", "tax", "netPay"]);
      return out;
    },
    importSupported: true,
    label: "Payroll entry",
  },
  invoices: {
    table: invoicesTable,
    insertSchema: insertInvoiceSchema as unknown as z.ZodSchema<any>,
    searchColumns: [invoicesTable.invoiceNumber, invoicesTable.clientName, invoicesTable.status],
    orderBy: invoicesTable.createdAt,
    coerceWrite: (v) => {
      let out = applyDateCoercion(v, ["paidAt"]);
      out = applyNumericCoercion(out, ["subtotal", "taxAmount", "totalAmount"]);
      return out;
    },
    importSupported: true,
    label: "Invoice",
  },
  incidents: {
    table: incidentsTable,
    insertSchema: insertIncidentSchema as unknown as z.ZodSchema<any>,
    searchColumns: [incidentsTable.title, incidentsTable.description, incidentsTable.severity, incidentsTable.status],
    orderBy: incidentsTable.occurredAt,
    coerceWrite: (v) => {
      let out = applyDateCoercion(v, ["occurredAt", "resolvedAt"]);
      out = applyNumericCoercion(out, ["lat", "lng"]);
      return out;
    },
    importSupported: true,
    label: "Incident",
  },
  licenses: {
    table: licensesTable,
    insertSchema: insertLicenseSchema as unknown as z.ZodSchema<any>,
    searchColumns: [licensesTable.type, licensesTable.licenseNumber, licensesTable.issuingAuthority],
    orderBy: licensesTable.expiryDate,
    coerceWrite: (v) => applyIntCoercion(v, ["level"]),
    importSupported: true,
    label: "License",
  },
  "training-certifications": {
    table: trainingCertificationsTable,
    // No drizzle-zod insert schema — we keep validation in routes/trainings.ts
    // (the dedicated officer + admin endpoints). z.any() lets the generic
    // admin grid pass through; the table's NOT NULL columns still enforce
    // shape at the DB layer.
    insertSchema: z.any() as z.ZodSchema<any>,
    searchColumns: [trainingCertificationsTable.title, trainingCertificationsTable.type, trainingCertificationsTable.certificateNumber],
    orderBy: trainingCertificationsTable.expiryDate,
    coerceWrite: (v) => v,
    importSupported: false,
    label: "Training certification",
  },
  subcontractors: {
    table: subcontractorsTable,
    insertSchema: insertSubcontractorSchema as unknown as z.ZodSchema<any>,
    searchColumns: [subcontractorsTable.companyName, subcontractorsTable.contactName, subcontractorsTable.contactEmail, subcontractorsTable.status],
    orderBy: subcontractorsTable.companyName,
    coerceWrite: (v) => applyIntCoercion(v, ["paymentTermsDays"]),
    importSupported: true,
    label: "Subcontractor",
  },
  subcontractor_cois: {
    table: subcontractorCoisTable,
    insertSchema: insertSubcontractorCoiSchema as unknown as z.ZodSchema<any>,
    searchColumns: [subcontractorCoisTable.coverageType, subcontractorCoisTable.insurer, subcontractorCoisTable.policyNumber],
    orderBy: subcontractorCoisTable.expiryDate,
    coerceWrite: (v) =>
      // effectiveDate / expiryDate are `date` columns — drizzle-zod expects
      // ISO date strings, NOT Date objects, so they pass through untouched
      // (same as licenses.expiryDate).
      applyNumericCoercion(v, ["coverageAmount"]),
    importSupported: false,
    label: "Certificate of Insurance",
  },
  subcontractor_contracts: {
    table: subcontractorContractsTable,
    insertSchema: insertSubcontractorContractSchema as unknown as z.ZodSchema<any>,
    searchColumns: [subcontractorContractsTable.title, subcontractorContractsTable.contractType, subcontractorContractsTable.status],
    orderBy: subcontractorContractsTable.createdAt,
    coerceWrite: (v) =>
      // startDate / endDate are `date` columns — pass ISO strings through.
      applyNumericCoercion(v, ["value"]),
    importSupported: false,
    label: "Subcontractor contract",
  },
  subcontractor_invoices: {
    table: subcontractorInvoicesTable,
    insertSchema: insertSubcontractorInvoiceSchema as unknown as z.ZodSchema<any>,
    searchColumns: [subcontractorInvoicesTable.invoiceNumber, subcontractorInvoicesTable.description, subcontractorInvoicesTable.status],
    orderBy: subcontractorInvoicesTable.createdAt,
    coerceWrite: (v) => {
      // issueDate / dueDate are `date` columns (ISO strings); approvedAt /
      // paidAt are `timestamp` columns and DO need Date coercion.
      let out = applyDateCoercion(v, ["approvedAt", "paidAt"]);
      out = applyNumericCoercion(out, ["subtotal", "taxAmount", "totalAmount"]);
      return out;
    },
    importSupported: false,
    label: "Subcontractor invoice",
  },
};

function getConfig(name: string): TableConfig | null {
  return tables[name] ?? null;
}

// ---- FK resolution metadata for import-by-label ----------------------------
//
// When the importer chooses "match by name/email/title" instead of UUID, we
// resolve each row's FK column against the target table here on the server.
// `matchColumns` lists the columns that together uniquely identify a row in
// the target table — for shifts that's title + startTime because two shifts
// often share a title across different days.
//
// Adding a new resolvable FK = add an entry. Lookup is whitelisted to these
// entries so callers can't ask the server to query arbitrary tables.

type FkMatchType = "text" | "date";
type FkMatchColumn = { key: string; col: AnyColumn; type: FkMatchType };
type FkRef = {
  table: any;
  matchColumns: FkMatchColumn[];
  /**
   * Optional alternate primary-key extractors. For each candidate row, returns
   * additional normalized strings to register in the lookup map alongside the
   * primary key. Used so users can be matched by full name ("John Smith") in
   * addition to email. When set, the resolver fetches the entire target table
   * (no pre-filter) so alt-key matches aren't excluded by the email IN clause.
   */
  altPrimaryKeys?: (row: any) => string[];
  /**
   * If provided, unresolved labels trigger this factory which creates a
   * placeholder record and returns its id, so an import can populate now and
   * the admin can flesh out the row later. Time-entries use this for employee
   * names that don't match an existing user (creates a `pending` user +
   * employee with `mustCompleteProfile=true`). Skipped on dry-run preview.
   */
  autoCreate?: (rawLabel: string) => Promise<string>;
};

/** Lower-trim-collapse-whitespace for free-text comparisons. */
function normText(s: unknown): string {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const userFullNameAlt = (u: any): string[] => {
  const full = normText(`${u.firstName ?? ""} ${u.lastName ?? ""}`);
  return full ? [full] : [];
};

/** Splits "Nabian ramirez" or "Victor Jamal wheeler" into first / last with
 *  reasonable defaults. Single-word names go into firstName with a placeholder
 *  lastName so the not-null constraint is satisfied. */
function splitFullName(label: string): { firstName: string; lastName: string } {
  const parts = label.trim().replace(/\s+/g, " ").split(" ");
  if (parts.length === 0 || !parts[0]) return { firstName: "Imported", lastName: "Employee" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "(unknown)" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Auto-creates a site from a free-text name found in a time-entries import.
 *  Sites require a client, so we find-or-create a placeholder "Imported"
 *  client to attach to. The site can be moved to the correct client later.
 *  Runs as its own transaction so the new site exists even if the surrounding
 *  import partially fails. */
async function autoCreateSiteFromName(label: string): Promise<string> {
  const name = label.trim() || "Imported Site";
  return await db.transaction(async (tx) => {
    // Find or create the placeholder client
    const existing = await tx.select({ id: clientsTable.id })
      .from(clientsTable)
      .where(eq(clientsTable.name, "Imported"))
      .limit(1);
    let clientId: string;
    if (existing.length > 0) {
      clientId = existing[0].id;
    } else {
      const [c] = await tx.insert(clientsTable).values({
        name: "Imported",
        contactName: "Import",
        contactEmail: "import@imported.local",
        paymentTermsDays: 30,
      }).returning() as Array<{ id: string }>;
      clientId = c.id;
    }
    // Create the site
    const [s] = await tx.insert(sitesTable).values({ name, clientId }).returning() as Array<{ id: string }>;
    return s.id;
  });
}

/** Auto-creates a `pending` user + employee from a free-text full name found
 *  in a time-entries import. The placeholder email is unique-by-construction
 *  so the row inserts cleanly; `mustCompleteProfile=true` flags the row for
 *  the admin to finish later. Runs as its own transaction so the new user
 *  exists even if the surrounding import partially fails. */
async function autoCreateEmployeeFromName(label: string): Promise<string> {
  const { firstName, lastName } = splitFullName(label);
  const slug = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "imported";
  const short = randomBytes(3).toString("hex");
  const email = `${slug}+import-${short}@imported.local`;
  const passwordHash = await bcrypt.hash(randomBytes(16).toString("hex"), 10);
  return await db.transaction(async (tx) => {
    const [u] = (await tx.insert(usersTable).values({
      email, passwordHash, firstName, lastName,
      role: "employee",
      status: "pending",
      mustCompleteProfile: true,
    }).returning()) as Array<{ id: string }>;
    await tx.insert(employeesTable).values({ userId: u.id });
    return u.id;
  });
}

/** Shifts in spreadsheets often append the required licence level to the title
 *  (e.g. "Acme Patrol 3" where 3 = level 3). Register a "<title> <level>"
 *  variant so those values resolve to the same shift row. */
const shiftTitleWithLevelAlt = (s: any): string[] => {
  const title = normText(s.title);
  const lvl = s.requiredLicenseLevel;
  return title && (lvl === 1 || lvl === 2 || lvl === 3 || lvl === 4)
    ? [`${title} ${lvl}`]
    : [];
};

const fkResolution: Record<string, Record<string, FkRef>> = {
  shift_assignments: {
    employeeId: { table: usersTable, matchColumns: [{ key: "email", col: usersTable.email, type: "text" }] },
    shiftId: { table: shiftsTable, matchColumns: [
      { key: "title", col: shiftsTable.title, type: "text" },
      { key: "startTime", col: shiftsTable.startTime, type: "date" },
    ] },
  },
  time_entries: {
    // Employee can be matched by email OR full name ("John Smith"), since spreadsheets
    // commonly carry names rather than emails for hours imports.
    employeeId: {
      table: usersTable,
      matchColumns: [{ key: "email", col: usersTable.email, type: "text" }],
      altPrimaryKeys: userFullNameAlt,
      autoCreate: autoCreateEmployeeFromName,
    },
    shiftId: {
      table: shiftsTable,
      matchColumns: [
        { key: "title", col: shiftsTable.title, type: "text" },
        { key: "startTime", col: shiftsTable.startTime, type: "date" },
      ],
      altPrimaryKeys: shiftTitleWithLevelAlt,
    },
    siteId: { table: sitesTable, matchColumns: [{ key: "name", col: sitesTable.name, type: "text" }], autoCreate: autoCreateSiteFromName },
  },
  licenses: {
    employeeId: { table: usersTable, matchColumns: [{ key: "email", col: usersTable.email, type: "text" }] },
  },
  "training-certifications": {
    employeeId: { table: usersTable, matchColumns: [{ key: "email", col: usersTable.email, type: "text" }] },
  },
  incidents: {
    employeeId: { table: usersTable, matchColumns: [{ key: "email", col: usersTable.email, type: "text" }] },
    shiftId: { table: shiftsTable, matchColumns: [
      { key: "title", col: shiftsTable.title, type: "text" },
      { key: "startTime", col: shiftsTable.startTime, type: "date" },
    ] },
  },
  shifts: {
    siteId: { table: sitesTable, matchColumns: [{ key: "name", col: sitesTable.name, type: "text" }] },
  },
  sites: {
    clientId: { table: clientsTable, matchColumns: [{ key: "name", col: clientsTable.name, type: "text" }] },
  },
  employees: {
    userId: { table: usersTable, matchColumns: [{ key: "email", col: usersTable.email, type: "text" }] },
  },
  payroll_entries: {
    employeeId: { table: usersTable, matchColumns: [{ key: "email", col: usersTable.email, type: "text" }] },
    siteId: { table: sitesTable, matchColumns: [{ key: "name", col: sitesTable.name, type: "text" }] },
  },
  invoices: {
    clientId: { table: clientsTable, matchColumns: [{ key: "name", col: clientsTable.name, type: "text" }] },
    siteId: { table: sitesTable, matchColumns: [{ key: "name", col: sitesTable.name, type: "text" }] },
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize a value to a stable lookup key. Dates are coerced to ISO so
 *  Excel-numbers, "2024-01-15", "1/15/2024 8:00", and JS Date all collapse to
 *  the same key. */
function normalizeMatchValue(v: unknown, type: FkMatchType): string {
  if (v === undefined || v === null || v === "") return "";
  if (type === "date") {
    const d = toDateOrNull(v);
    return d ? d.toISOString() : "";
  }
  return String(v).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolve label values to UUIDs in-place on `rows` for any FK columns the
 * caller marked as `{ by: "label" }`. Returns a map of rowIndex -> error
 * message for unresolved rows so the import handler can short-circuit them.
 */
async function resolveImportFks(
  tableName: string,
  rows: any[],
  resolveHints: Record<string, { by?: "id" | "label" }>,
  matchExtras: Array<Record<string, Record<string, unknown>> | undefined>,
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<{ errors: Map<number, string>; autoCreated: Record<string, string[]> }> {
  const errors = new Map<number, string>();
  const autoCreated: Record<string, string[]> = {};
  const refs = fkResolution[tableName];
  if (!refs) return { errors, autoCreated };

  for (const [fkKey, hint] of Object.entries(resolveHints)) {
    if (hint?.by !== "label") continue;
    const ref = refs[fkKey];
    if (!ref) continue;
    const primary = ref.matchColumns[0];

    // Collect distinct primary lookup values across all rows so we can fetch
    // candidates in one query rather than N.
    const primaries = new Set<string>();
    rows.forEach((r) => {
      if (!r || typeof r !== "object") return;
      const v = r[fkKey];
      if (v === undefined || v === null || v === "") return;
      const s = String(v);
      if (UUID_RE.test(s)) return;
      const norm = normalizeMatchValue(s, primary.type);
      if (norm) primaries.add(norm);
    });
    if (primaries.size === 0) continue;

    let candidates: any[] = [];
    if (ref.altPrimaryKeys) {
      // Alt-key support means a row may match by something other than the
      // primary column (e.g. users by full name instead of email), so we can't
      // pre-filter — fetch the whole table and let the in-memory map sort it out.
      candidates = await db.select().from(ref.table);
    } else if (primary.type === "text") {
      candidates = await db
        .select()
        .from(ref.table)
        .where(inArray(sql`lower(${primary.col}::text)`, [...primaries]));
    } else {
      // Date primaries are uncommon but supported — fall back to range fetch.
      candidates = await db.select().from(ref.table);
    }

    // Track ids per key so we can flag ambiguity (e.g. two users named "John Smith")
    // instead of silently last-write-wins. Primary-column duplicates aren't surfaced
    // because they imply real DB-level duplication that's not specific to this row.
    const map = new Map<string, string>();
    const altCollisions = new Map<string, Set<string>>();
    for (const c of candidates) {
      const id = String(c.id ?? "");
      if (!id) continue;
      const tail = ref.matchColumns
        .slice(1)
        .map((mc) => normalizeMatchValue(c[mc.key], mc.type))
        .join("|");
      const tailSuffix = ref.matchColumns.length > 1 ? `|${tail}` : "";

      // Register the primary-column key.
      const primaryKey = normalizeMatchValue(c[primary.key], primary.type);
      if (primaryKey) map.set(primaryKey + tailSuffix, id);

      // Register alt-keys, recording collisions for ambiguity detection.
      if (ref.altPrimaryKeys) {
        for (const alt of ref.altPrimaryKeys(c)) {
          if (!alt) continue;
          const k = alt + tailSuffix;
          // Don't fight a real primary match — alt only fills in when primary is absent.
          if (!map.has(k)) map.set(k, id);
          const set = altCollisions.get(k) ?? new Set<string>();
          set.add(id);
          altCollisions.set(k, set);
        }
      }
    }

    // Cache auto-created ids per normalized primary value so multiple rows for
    // the same new employee dedupe to a single insert.
    const autoCreatedThisField = new Map<string, string>();
    const tasks: Array<{ index: number; rawLabel: string; key: string; lookupKey: string }> = [];

    rows.forEach((r, i) => {
      if (!r || typeof r !== "object") return;
      const v = r[fkKey];
      if (v === undefined || v === null || v === "") return;
      const s = String(v);
      if (UUID_RE.test(s)) return; // Already an ID, leave alone.
      const parts: string[] = [normalizeMatchValue(s, primary.type)];
      for (let m = 1; m < ref.matchColumns.length; m++) {
        const mc = ref.matchColumns[m];
        const extra = matchExtras[i]?.[fkKey]?.[mc.key];
        parts.push(normalizeMatchValue(extra, mc.type));
      }
      const key = parts.join("|");
      const collisions = altCollisions.get(key);
      if (collisions && collisions.size > 1) {
        // Ambiguous alt-key match (e.g. two users named "John Smith"). Better
        // to fail loudly than silently pick the wrong record.
        errors.set(i, `${fkKey}: "${s}" matches ${collisions.size} records — please use email or a unique value to disambiguate`);
        return;
      }
      const resolved = map.get(key);
      if (resolved) {
        r[fkKey] = resolved;
        return;
      }
      if (ref.autoCreate) {
        // Defer creation so we can dedupe + create sequentially below.
        tasks.push({ index: i, rawLabel: s, key: parts[0], lookupKey: key });
        return;
      }
      const labelParts = ref.matchColumns.map((mc, idx) => {
        const raw = idx === 0 ? s : matchExtras[i]?.[fkKey]?.[mc.key];
        return raw === undefined || raw === null || raw === "" ? "(blank)" : String(raw);
      });
      errors.set(i, `${fkKey}: no ${ref.matchColumns.map((mc) => mc.key).join("+")} match for "${labelParts.join(" / ")}"`);
    });

    if (tasks.length > 0 && ref.autoCreate) {
      const created: string[] = [];
      for (const t of tasks) {
        try {
          let id = autoCreatedThisField.get(t.key);
          if (!id) {
            if (opts.dryRun) {
              // Sentinel so insert-schema UUID validation passes during preview;
              // no row is actually written because the handler short-circuits.
              id = "00000000-0000-0000-0000-000000000000";
            } else {
              id = await ref.autoCreate(t.rawLabel);
            }
            autoCreatedThisField.set(t.key, id);
            created.push(t.rawLabel);
          }
          rows[t.index][fkKey] = id;
        } catch (err: any) {
          errors.set(t.index, `${fkKey}: auto-create failed for "${t.rawLabel}" — ${err?.message ?? "unknown error"}`);
        }
      }
      if (created.length > 0) autoCreated[fkKey] = created;
    }
  }
  return { errors, autoCreated };
}

// ---- Routes ----------------------------------------------------------------

/**
 * Build the shared WHERE clause + sort column/dir for the generic table list
 * from a request's query (search / filter[col] / sort / dir). Extracted so the
 * list handler and the row-position handler stay byte-for-byte identical in how
 * they filter and order — otherwise a deep-link could resolve to a page the
 * list never renders the row on.
 */
function buildListQueryParts(
  cfg: TableConfig,
  tableName: string,
  query: Request["query"],
): { where: any; sortColumn: AnyColumn; sortDir: "asc" | "desc" } {
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const sortField = typeof query.sort === "string" ? query.sort : "";
  const sortDir = query.dir === "asc" ? "asc" : "desc";

  // Equality filters via ?filter[col]=val. Whitelisted to actual table columns
  // so callers can't inject arbitrary SQL identifiers.
  const filterClauses = [] as any[];
  const rawFilter = query.filter;
  if (rawFilter && typeof rawFilter === "object" && !Array.isArray(rawFilter)) {
    for (const [col, val] of Object.entries(rawFilter as Record<string, unknown>)) {
      const column = (cfg.table as any)[col];
      if (column && typeof val === "string" && val.length > 0) {
        filterClauses.push(eq(column, val));
      }
    }
  }

  const ownColumnClauses = search && cfg.searchColumns.length > 0
    ? cfg.searchColumns.map((c) => ilike(sql`${c}::text`, `%${search}%`))
    : [];
  // For the employees table, names + email live on the joined users row,
  // so a plain column-match against employees returns nothing for the
  // most common admin search ("type the officer's name"). Extend the
  // search to include the linked user via a correlated EXISTS.
  if (search && tableName === "employees") {
    const like = `%${search}%`;
    ownColumnClauses.push(sql`EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = ${employeesTable.userId}
        AND (
          u.first_name ILIKE ${like}
          OR u.last_name ILIKE ${like}
          OR (u.first_name || ' ' || u.last_name) ILIKE ${like}
          OR u.email ILIKE ${like}
        )
    )` as any);
  }
  const searchClause = ownColumnClauses.length > 0
    ? or(...ownColumnClauses)
    : undefined;
  const where = filterClauses.length > 0
    ? (searchClause ? and(searchClause, ...filterClauses) : and(...filterClauses))
    : searchClause;

  const sortColumn = sortField && (cfg.table as any)[sortField] ? (cfg.table as any)[sortField] : cfg.orderBy;
  return { where, sortColumn, sortDir };
}

router.get("/admin/tables", requireAdmin, (_req, res): void => {
  const list = Object.entries(tables).map(([name, cfg]) => ({
    name,
    label: cfg.label,
    importSupported: cfg.importSupported,
  }));
  res.json(list);
});

router.get("/admin/tables/:table", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }

  const limitRaw = Number(req.query.limit ?? 50);
  const offsetRaw = Number(req.query.offset ?? 0);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50), 500);
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const { where, sortColumn, sortDir } = buildListQueryParts(cfg, tableName, req.query);
  // Stable secondary sort on the primary key so ties on the chosen column have a
  // deterministic order. Without this, two rows sharing a sort value could swap
  // pages between requests, which would also break the row-position deep-link.
  const idColumn = (cfg.table as any).id as AnyColumn;
  const order = sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [rows, totalRows] = await Promise.all([
    db.select().from(cfg.table).where(where).orderBy(order, asc(idColumn)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(cfg.table).where(where),
  ]);

  // Redact sensitive columns for the users table — the dedicated invitation
  // endpoints expose temp passwords intentionally; the generic list shouldn't.
  const safeRows = tableName === "users"
    ? (rows as Record<string, unknown>[]).map(({ passwordHash: _ph, tempPasswordPlain: _tp, ...rest }) => rest)
    : rows;

  res.json({ rows: safeRows, total: totalRows[0]?.count ?? 0, limit, offset });
});

// Single-row fetch — used by detail pages (e.g. SiteDetailPage) that need
// the full row by id rather than a paginated list. Mirrors the list route's
// users-table redaction so temp passwords / password hashes never leak.
router.get("/admin/tables/:table/:id", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const id = String(req.params.id);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }
  const rows = (await db
    .select()
    .from(cfg.table)
    .where(eq((cfg.table as any).id, id))
    .limit(1)) as Record<string, unknown>[];
  if (rows.length === 0) {
    res.status(404).json({ error: "Not Found", message: `${tableName}/${id} not found` });
    return;
  }
  const row = rows[0];
  if (tableName === "users") {
    const { passwordHash: _ph, tempPasswordPlain: _tp, ...safe } = row;
    res.json(safe);
    return;
  }
  res.json(row);
});

// Row position — returns a row's 0-based global index (and the page it lands on)
// under the SAME sort/filter/search the list grid uses, computed entirely in the
// DB via a single window-function query. Powers instant deep-link focus: the
// grid jumps straight to the right page instead of scanning the result set in
// client-side batches. Uses the identical (sort, id) ordering as the list route
// so the page returned here is exactly where the list renders the row.
router.get("/admin/tables/:table/:id/position", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const id = String(req.params.id);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }

  const pageSizeRaw = Number(req.query.pageSize ?? 25);
  const pageSize = Math.min(Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25), 500);

  const { where, sortColumn, sortDir } = buildListQueryParts(cfg, tableName, req.query);
  const idColumn = (cfg.table as any).id as AnyColumn;
  // Match the list route's ORDER BY exactly (chosen column + id tiebreaker) so
  // row_number() yields the row's real position in the rendered list.
  const orderSql = sortDir === "asc"
    ? sql`${sortColumn} asc, ${idColumn} asc`
    : sql`${sortColumn} desc, ${idColumn} asc`;

  const ranked = db
    .select({
      id: sql`${idColumn}`.as("rid"),
      idx: sql<number>`(row_number() over (order by ${orderSql}) - 1)::int`.as("idx"),
    })
    .from(cfg.table)
    .where(where)
    .as("ranked");

  const found = (await db
    .select({ idx: ranked.idx })
    .from(ranked)
    .where(eq(ranked.id, id))
    .limit(1)) as Array<{ idx: number }>;

  if (found.length === 0) {
    // Row isn't in the filtered/searched set (deleted, filtered out, or wrong
    // id). The `code` marker lets the client tell THIS authoritative 404 apart
    // from a generic missing-route 404 (older server without this endpoint) so
    // it only skips the fallback scan when the row is genuinely absent.
    res.status(404).json({
      error: "Not Found",
      code: "row_not_in_result_set",
      message: `${tableName}/${id} not in result set`,
    });
    return;
  }

  const index = found[0].idx;
  res.json({ id, index, page: Math.floor(index / pageSize), pageSize });
});

router.post("/admin/tables/:table", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }
  let coerced: Record<string, unknown>;
  try {
    coerced = cfg.coerceWrite((req.body ?? {}) as Record<string, unknown>);
  } catch (err: any) {
    if (err?.__badRequest) {
      res.status(400).json({ error: "Bad Request", message: err.message });
      return;
    }
    throw err;
  }
  const parsed = cfg.insertSchema.safeParse(coerced);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation",
      message: `${cfg.label} validation failed`,
      issues: parsed.error.issues,
    });
    return;
  }
  let values = parsed.data as Record<string, unknown>;
  if (cfg.beforeInsert) values = await cfg.beforeInsert(values);
  try {
    const inserted = (await db.insert(cfg.table).values(values).returning()) as unknown[];
    res.status(201).json(inserted[0]);
  } catch (err: any) {
    req.log.warn({ err }, "admin insert failed");
    res.status(400).json({ error: "Insert failed", message: err?.message ?? "Insert failed" });
  }
});

router.put("/admin/tables/:table/:id", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const id = String(req.params.id);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }

  // For update we use a relaxed validation: parse a partial schema.
  let body: Record<string, unknown> = req.body && typeof req.body === "object" ? { ...req.body } : {};
  if (tableName === "users") {
    const parsed = updateUserAdminSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation", message: "User validation failed", issues: parsed.error.issues });
      return;
    }
    body = { ...parsed.data };
    if (body.password) {
      body.passwordHash = await bcrypt.hash(String(body.password), 10);
      delete body.password;
    }
    if (typeof body.email === "string") body.email = body.email.toLowerCase();
    // Normalize phoneNumber to E.164 (same rule the public flows use) so
    // admin edits don't silently break SMS dispatch for that user.
    const phoneErr = normalizePhoneFieldInPlace(body, "phoneNumber", "Phone number");
    if (phoneErr) {
      res.status(400).json({ error: "Bad Request", message: phoneErr });
      return;
    }
  } else {
    try {
      body = cfg.coerceWrite(body);
    } catch (err: any) {
      if (err?.__badRequest) {
        res.status(400).json({ error: "Bad Request", message: err.message });
        return;
      }
      throw err;
    }
  }

  // Strip undefined and immutable fields
  delete body.id;
  delete body.createdAt;
  delete body.updatedAt;
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No fields to update" });
    return;
  }

  try {
    // For the employees table, snapshot the row first so we can diff into
    // employee_changes. The generic spreadsheet update bypasses the
    // dedicated /employees/:id handler, so we have to replicate the log
    // write here too — otherwise admin grid edits go untracked.
    // For the sites table, we also snapshot first so an address change can
    // invalidate stale lat/lng (so the post-update auto-geocode picks up
    // fresh coords for the new address).
    let beforeRow: Record<string, unknown> | null = null;
    if (tableName === "employees" || tableName === "sites") {
      const rows = (await db
        .select()
        .from(cfg.table)
        .where(eq((cfg.table as any).id, id))) as Record<string, unknown>[];
      beforeRow = rows[0] ?? null;
    }

    if (tableName === "sites" && beforeRow) {
      body = prepareSitePreUpdate(beforeRow as any, body);
    }

    // Invoice auto-sync opt-out: any admin grid edit to a billable field
    // flips auto_synced=false so the next time-entry approval can't
    // overwrite their hand-tuned numbers. See lib/invoiceSync.ts for the
    // full mutability contract.
    if (tableName === "invoices" && adminEditBreaksAutoSync(body)) {
      body.autoSynced = false;
    }

    const updated = (await db.update(cfg.table).set(body).where(eq((cfg.table as any).id, id)).returning()) as unknown[];
    let row = updated[0];
    if (!row) {
      res.status(404).json({ error: "Not Found", message: `${cfg.label} not found` });
      return;
    }

    if (tableName === "sites") {
      row = await maybeAutoGeocodeSite(row as Record<string, unknown>, req.log);
    }

    if (tableName === "employees" && beforeRow) {
      const employeeUserId = (beforeRow.userId as string | undefined)
        ?? ((row as Record<string, unknown>).userId as string | undefined);
      if (employeeUserId) {
        await writeEmployeeFieldChanges({
          employeeUserId,
          keys: Object.keys(body),
          before: beforeRow,
          after: row as Record<string, unknown>,
          actor: { userId: req.user!.userId, email: req.user!.email, role: req.user!.role },
          log: req.log,
        });
      }
    }

    res.json(row);
  } catch (err: any) {
    req.log.warn({ err }, "admin update failed");
    res.status(400).json({ error: "Update failed", message: err?.message ?? "Update failed" });
  }
});

router.delete("/admin/tables/:table/:id", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const id = String(req.params.id);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }
  try {
    const result = (await db.delete(cfg.table).where(eq((cfg.table as any).id, id)).returning()) as unknown[];
    if (result.length === 0) {
      res.status(404).json({ error: "Not Found", message: `${cfg.label} not found` });
      return;
    }
    res.sendStatus(204);
  } catch (err: any) {
    req.log.warn({ err }, "admin delete failed");
    res.status(400).json({ error: "Delete failed", message: err?.message ?? "Delete failed" });
  }
});

// Bulk import — used by the Excel import flow in the portal.
// Accepts {rows: Record<string, unknown>[]} where each row is a pre-mapped
// object matching the table's insert schema. Inserts valid rows in a single
// transaction; returns per-row results so the UI can show "N inserted, M errors".
router.post("/admin/import/:table", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }
  if (!cfg.importSupported) {
    res.status(400).json({ error: "Bad Request", message: `Import is not enabled for ${cfg.label}` });
    return;
  }

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) {
    res.status(400).json({ error: "Bad Request", message: "Body must include 'rows' array" });
    return;
  }
  const resolveHints = (req.body?.resolve && typeof req.body.resolve === "object"
    ? req.body.resolve
    : {}) as Record<string, { by?: "id" | "label" }>;
  const matchExtras = Array.isArray(req.body?.matchExtras) ? req.body.matchExtras : [];
  const dryRun = req.body?.dryRun === true;

  type RowResult = { index: number; ok: boolean; id?: string; error?: string };
  const results: RowResult[] = [];

  // Authoritative server-side FK resolution. The browser may have pre-resolved
  // some values to UUIDs; we only re-resolve rows that still hold raw labels,
  // which makes this idempotent with the wizard's preview behavior.
  let fkErrors = new Map<number, string>();
  let autoCreated: Record<string, string[]> = {};
  try {
    const out = await resolveImportFks(tableName, rows, resolveHints, matchExtras, { dryRun });
    fkErrors = out.errors;
    autoCreated = out.autoCreated;
  } catch (err: any) {
    req.log.warn({ err }, "FK resolution failed");
    res.status(400).json({ error: "FK resolution failed", message: err?.message ?? "FK resolution failed" });
    return;
  }

  // Validate everything first so we don't insert partial data
  const validated: { index: number; values: Record<string, unknown> }[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (fkErrors.has(i)) {
      results.push({ index: i, ok: false, error: fkErrors.get(i)! });
      continue;
    }
    const r = cfg.coerceWrite(rows[i]);
    const parsed = cfg.insertSchema.safeParse(r);
    if (!parsed.success) {
      results.push({
        index: i,
        ok: false,
        error: parsed.error.issues.map((x: z.core.$ZodIssue) => `${x.path.join(".")}: ${x.message}`).join("; "),
      });
      continue;
    }
    let values = parsed.data as Record<string, unknown>;
    if (cfg.beforeInsert) values = await cfg.beforeInsert(values);
    validated.push({ index: i, values });
  }

  if (dryRun) {
    // Surface what WOULD be inserted without touching the DB. Used by the
    // wizard's preview step so admins see authoritative resolution failures.
    for (const v of validated) {
      results.push({ index: v.index, ok: true });
    }
    results.sort((a, b) => a.index - b.index);
    res.json({
      inserted: 0,
      failed: results.filter((r) => !r.ok).length,
      total: rows.length,
      results,
      autoCreated,
      dryRun: true,
    });
    return;
  }

  // Insert valid rows in a transaction; on per-row failure record the error and continue.
  if (validated.length > 0) {
    await db.transaction(async (tx) => {
      for (const v of validated) {
        try {
          const inserted = (await tx.insert(cfg.table).values(v.values).returning()) as unknown[];
          results.push({ index: v.index, ok: true, id: (inserted[0] as any)?.id });
        } catch (err: any) {
          results.push({ index: v.index, ok: false, error: err?.message ?? "Insert failed" });
        }
      }
    });
  }

  results.sort((a, b) => a.index - b.index);
  const inserted = results.filter((r) => r.ok).length;
  const failed = results.length - inserted;
  res.status(201).json({ inserted, failed, total: rows.length, results, autoCreated });
});

// ---- Admin: force password reset for a user --------------------------------
//
// Lets an admin issue a single-use password reset link for an officer who
// can't access their email or whose self-service flow is unavailable.
// Mirrors the public /auth/forgot-password flow but:
//   - is admin-gated (requireAdmin)
//   - records the issuing admin's id on the token row (audit trail)
//   - returns the resetUrl + emailSent flag in the response so the admin
//     can copy/share the link if SMTP isn't configured.

const ADMIN_PASSWORD_RESET_TTL_MINUTES = 60;

function genAdminResetToken(): string {
  return randomBytes(24).toString("base64url");
}

function getAdminResetBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  return null;
}

// POST /admin/users/:userId/revoke-sessions — admin "kick this user out" action.
// Bumps the user's tokens_valid_after watermark so every existing JWT
// (REST and WebSocket) is rejected on the very next request. Use after a
// suspected compromise, lost device, or role change.
router.post("/admin/users/:userId/revoke-sessions", requireAdmin, async (req, res): Promise<void> => {
  const { userId } = req.params as { userId: string };
  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  // Floor to second precision for consistency with JWT iat granularity.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await db.update(usersTable).set({ tokensValidAfter: now }).where(eq(usersTable.id, userId));
  // Force-close any open WebSocket connections for this user immediately so
  // they cannot continue receiving chat / live-ops broadcasts after revocation.
  disconnectUser(userId);
  req.log.info({ targetUserId: userId, byAdmin: req.user!.userId }, "Admin revoked all sessions for user");
  res.json({ success: true, revokedAt: now.toISOString(), email: user.email });
});

router.post("/admin/users/:userId/password-reset", requireAdmin, async (req, res): Promise<void> => {
  const userId = req.params.userId as string;
  const adminUserId = req.user!.userId;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }

  // Invalidate any prior unconsumed tokens for this user — only one live
  // reset link at a time.
  await db.update(passwordResetTokensTable)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(passwordResetTokensTable.userId, user.id),
      sql`${passwordResetTokensTable.consumedAt} IS NULL`,
    ));

  const token = genAdminResetToken();
  const expiresAt = new Date(Date.now() + ADMIN_PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
  await db.insert(passwordResetTokensTable).values({
    token,
    userId: user.id,
    expiresAt,
    requestIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null,
    issuedBy: adminUserId,
  });

  const base = getAdminResetBaseUrl();
  const resetUrl = base ? `${base}/admin-portal/reset-password/${token}` : null;

  let emailSent = false;
  if (resetUrl) {
    const msg = renderPasswordResetEmail({
      firstName: user.firstName,
      resetUrl,
      expiresInMinutes: ADMIN_PASSWORD_RESET_TTL_MINUTES,
    });
    emailSent = await sendEmail({ to: user.email, subject: msg.subject, text: msg.text, html: msg.html });
    if (emailSent) {
      req.log.info({ userId: user.id, adminUserId }, "Admin-issued password reset email sent");
    } else {
      req.log.info({ userId: user.id, adminUserId }, "Admin-issued password reset — email not sent (no SMTP); admin must share link manually");
    }
  } else {
    req.log.warn({ userId: user.id, adminUserId }, "Admin-issued password reset — APP_BASE_URL/REPLIT_DOMAINS unset; cannot build link");
  }

  res.json({
    resetUrl,
    expiresAt: expiresAt.toISOString(),
    expiresInMinutes: ADMIN_PASSWORD_RESET_TTL_MINUTES,
    emailSent,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk invitations: temp passwords + invite emails
// ─────────────────────────────────────────────────────────────────────────────
//
// Two-phase admin workflow:
//   1. POST /admin/users/bulk-temp-passwords  → assign random temp passwords
//      to non-admin users (stored in users.temp_password_plain alongside the
//      hashed users.password_hash so the admin can review/copy them later).
//   2. POST /admin/users/bulk-invite          → email selected users their
//      sign-in URL + temp password, then clear temp_password_plain and set
//      invited_at.
//
// Admins (role='admin') are NEVER targeted by either endpoint.

// Avoid ambiguous chars (0/O, 1/I/l) so admins reading temp passwords aloud
// don't fumble.
const TEMP_PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const TEMP_PW_LENGTH = 10;
function genTempPassword(): string {
  const buf = randomBytes(TEMP_PW_LENGTH);
  let out = "";
  for (let i = 0; i < TEMP_PW_LENGTH; i++) {
    out += TEMP_PW_ALPHABET[buf[i]! % TEMP_PW_ALPHABET.length];
  }
  return out;
}

const bulkTempPasswordsBody = z.object({
  scope: z.enum(["all_non_admin", "by_ids"]).default("by_ids"),
  userIds: z.array(z.string().uuid()).optional(),
  // When false (default): only generate for users that don't already have a
  // pending temp password (i.e. tempPasswordPlain IS NULL OR invitedAt IS NOT NULL).
  // When true: rotate even if a usable temp password already exists.
  force: z.boolean().default(false),
});

router.post("/admin/users/bulk-temp-passwords", requireAdmin, async (req, res): Promise<void> => {
  const parsed = bulkTempPasswordsBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { scope, userIds, force } = parsed.data;

  // Resolve target user set.
  let targets: { id: string; email: string; firstName: string; lastName: string; role: string; status: string; tempPasswordPlain: string | null; invitedAt: Date | null }[];
  if (scope === "all_non_admin") {
    targets = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        role: usersTable.role,
        status: usersTable.status,
        tempPasswordPlain: usersTable.tempPasswordPlain,
        invitedAt: usersTable.invitedAt,
      })
      .from(usersTable)
      .where(sql`${usersTable.role} <> 'admin'`);
  } else {
    if (!userIds || userIds.length === 0) {
      res.status(400).json({ error: "Bad Request", message: "userIds required for scope=by_ids" });
      return;
    }
    targets = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        role: usersTable.role,
        status: usersTable.status,
        tempPasswordPlain: usersTable.tempPasswordPlain,
        invitedAt: usersTable.invitedAt,
      })
      .from(usersTable)
      .where(and(inArray(usersTable.id, userIds), sql`${usersTable.role} <> 'admin'`));
  }

  // Floor to second precision for consistency with JWT iat granularity.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const generated: { userId: string; email: string; firstName: string; lastName: string; tempPassword: string }[] = [];
  const skipped: { userId: string; email: string; reason: string }[] = [];

  for (const t of targets) {
    // Skip if a temp password already exists and the user hasn't been invited
    // yet (still usable) — unless caller forced regeneration.
    const hasUsableTemp = t.tempPasswordPlain && !t.invitedAt;
    if (hasUsableTemp && !force) {
      skipped.push({ userId: t.id, email: t.email, reason: "already_has_temp_password" });
      continue;
    }
    const plain = genTempPassword();
    const hash = await bcrypt.hash(plain, 10);
    await db.update(usersTable)
      .set({
        passwordHash: hash,
        tempPasswordPlain: plain,
        tempPasswordSetAt: now,
        invitedAt: null, // rotating a password effectively re-arms the invite
        mustChangePassword: true,
        // Bump the session watermark so any pre-rotation JWT is immediately
        // rejected on the next HTTP request or WS upgrade.
        tokensValidAfter: now,
      })
      .where(eq(usersTable.id, t.id));
    // Force-close any open WebSocket connections so the user cannot continue
    // receiving chat / live-ops broadcasts with now-invalidated credentials.
    disconnectUser(t.id);
    generated.push({ userId: t.id, email: t.email, firstName: t.firstName, lastName: t.lastName, tempPassword: plain });
  }

  req.log.info(
    { adminUserId: req.user!.userId, generated: generated.length, skipped: skipped.length, scope, force },
    "Bulk temp passwords generated",
  );

  res.json({
    generated,
    skipped,
    counts: {
      total: targets.length,
      generated: generated.length,
      skipped: skipped.length,
    },
  });
});

const bulkInviteBody = z.object({
  userIds: z.array(z.string().uuid()).min(1, "Pick at least one user"),
});

router.post("/admin/users/bulk-invite", requireAdmin, async (req, res): Promise<void> => {
  const parsed = bulkInviteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { userIds } = parsed.data;

  const targets = await db.select().from(usersTable)
    .where(and(inArray(usersTable.id, userIds), sql`${usersTable.role} <> 'admin'`));

  // Officers use the SecureOps mobile web app (the Expo app served at the
  // domain root), NOT the admin portal at /admin-portal/. Link them to the
  // root of the configured base URL. The invite still sends without a URL —
  // the email then tells officers to open the SecureOps app manually.
  const base = getAdminResetBaseUrl();
  const appUrl = base ? `${base}/` : null;

  const sent: { userId: string; email: string; emailSent: boolean }[] = [];
  const failed: { userId: string; email: string; reason: string }[] = [];

  for (const u of targets) {
    if (!u.tempPasswordPlain) {
      failed.push({ userId: u.id, email: u.email, reason: "no_temp_password — generate one first" });
      continue;
    }
    const msg = renderInviteEmail({
      firstName: u.firstName,
      email: u.email,
      tempPassword: u.tempPasswordPlain,
      appUrl,
    });
    let ok = false;
    try {
      ok = await sendEmail({ to: u.email, subject: msg.subject, text: msg.text, html: msg.html });
    } catch (e) {
      req.log.error({ err: e, userId: u.id }, "Invite email threw");
      failed.push({ userId: u.id, email: u.email, reason: (e as Error).message });
      continue;
    }
    if (!ok) {
      failed.push({ userId: u.id, email: u.email, reason: "smtp_not_configured — share the credentials manually" });
      continue;
    }
    // Email left the building. Clear the plaintext temp password — the user
    // now has it and we don't want it sitting in the DB indefinitely. Stamp
    // invited_at so the page can show the user is invited.
    await db.update(usersTable)
      .set({ tempPasswordPlain: null, invitedAt: new Date() })
      .where(eq(usersTable.id, u.id));
    sent.push({ userId: u.id, email: u.email, emailSent: true });
  }

  req.log.info(
    { adminUserId: req.user!.userId, sent: sent.length, failed: failed.length },
    "Bulk invites sent",
  );

  res.json({
    sent,
    failed,
    counts: { total: targets.length, sent: sent.length, failed: failed.length },
  });
});

// ============================================================ SITE RATE CARDS
//
// Per-site pay+bill rate card keyed by license level (L2 unarmed / L3 armed /
// L4 PPO). Shift create/edit pulls these into the form so each shift's pay
// and bill amounts reflect the site + position combo, with per-shift override
// still available. Admin-only — these are commercial rates and exposing them
// to officers would leak each site's margin.

// GET /admin/sites/:id/rates — list rate card rows for a site
router.get("/admin/sites/:id/rates", requireAdmin, async (req, res): Promise<void> => {
  const siteId = req.params.id as string;
  const rows = await db
    .select()
    .from(siteRatesTable)
    .where(eq(siteRatesTable.siteId, siteId))
    .orderBy(asc(siteRatesTable.licenseLevel));
  res.json(rows);
});

// PUT /admin/sites/:id/rates — upsert a row by (siteId, licenseLevel).
// Body: { licenseLevel: 2|3|4, payRate: number|string, billRate: number|string, label?: string }
router.put("/admin/sites/:id/rates", requireAdmin, async (req, res): Promise<void> => {
  const siteId = req.params.id as string;
  const { licenseLevel, payRate, billRate, label } = req.body ?? {};
  const lvl = Number(licenseLevel);
  if (![2, 3, 4].includes(lvl)) {
    res.status(400).json({ error: "Bad Request", message: "licenseLevel must be 2, 3, or 4" });
    return;
  }
  const pay = Number(payRate);
  const bill = Number(billRate);
  if (!Number.isFinite(pay) || pay < 0 || !Number.isFinite(bill) || bill < 0) {
    res.status(400).json({ error: "Bad Request", message: "payRate and billRate must be non-negative numbers" });
    return;
  }
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, siteId)).limit(1);
  if (!site) { res.status(404).json({ error: "Not Found", message: "Site not found" }); return; }
  const cleanLabel = typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : null;

  const [row] = await db
    .insert(siteRatesTable)
    .values({ siteId, licenseLevel: lvl, payRate: String(pay), billRate: String(bill), label: cleanLabel })
    .onConflictDoUpdate({
      target: [siteRatesTable.siteId, siteRatesTable.licenseLevel],
      set: { payRate: String(pay), billRate: String(bill), label: cleanLabel, updatedAt: new Date() },
    })
    .returning();
  res.json(row);
});

// DELETE /admin/site-rates/:id — remove a single rate-card row.
// Shifts pointing at it have siteRateId set null (FK on delete: set null);
// their snapshotted payRate/billRate are intentionally preserved.
router.delete("/admin/site-rates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const deleted = await db.delete(siteRatesTable).where(eq(siteRatesTable.id, id)).returning();
  if (deleted.length === 0) { res.status(404).json({ error: "Not Found", message: "Rate not found" }); return; }
  res.json({ ok: true });
});

// Read-only list for the Invitations page. Returns non-admin users with
// invite-related fields (including temp_password_plain — admin-only).
router.get("/admin/users/invitations", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      status: usersTable.status,
      tempPasswordPlain: usersTable.tempPasswordPlain,
      tempPasswordSetAt: usersTable.tempPasswordSetAt,
      invitedAt: usersTable.invitedAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(sql`${usersTable.role} <> 'admin'`)
    .orderBy(asc(usersTable.lastName), asc(usersTable.firstName));
  res.json(rows);
});

export default router;
