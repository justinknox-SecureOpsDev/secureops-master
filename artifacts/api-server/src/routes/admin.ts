import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql, desc, asc, ilike, or, and, type AnyColumn } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
  payrollEntriesTable,
  invoicesTable,
  incidentsTable,
  licensesTable,
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
  role: z.enum(["admin", "employee"]).default("employee"),
  status: z.enum(["active", "inactive", "pending"]).default("active"),
  expoPushToken: z.string().nullable().optional(),
});

const updateUserAdminSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z.enum(["admin", "employee"]).optional(),
  status: z.enum(["active", "inactive", "pending"]).optional(),
  expoPushToken: z.string().nullable().optional(),
});

// ---- Table registry ---------------------------------------------------------

const tables: Record<string, TableConfig> = {
  users: {
    table: usersTable,
    insertSchema: insertUserAdminSchema as unknown as z.ZodSchema<any>,
    searchColumns: [usersTable.email, usersTable.firstName, usersTable.lastName, usersTable.role],
    orderBy: usersTable.createdAt,
    coerceWrite: (v) => v,
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
    searchColumns: [employeesTable.phone, employeesTable.address],
    orderBy: employeesTable.createdAt,
    coerceWrite: (v) => applyNumericCoercion(v, ["hourlyRate"]),
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
    coerceWrite: (v) => applyNumericCoercion(v, ["locationLat", "locationLng"]),
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
      return out;
    },
    importSupported: false,
    label: "Shift",
  },
  shift_assignments: {
    table: shiftAssignmentsTable,
    insertSchema: insertShiftAssignmentSchema as unknown as z.ZodSchema<any>,
    searchColumns: [shiftAssignmentsTable.status],
    orderBy: shiftAssignmentsTable.createdAt,
    coerceWrite: (v) => v,
    importSupported: false,
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
    importSupported: false,
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
    importSupported: false,
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
    importSupported: false,
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
    importSupported: false,
    label: "Incident",
  },
  licenses: {
    table: licensesTable,
    insertSchema: insertLicenseSchema as unknown as z.ZodSchema<any>,
    searchColumns: [licensesTable.type, licensesTable.licenseNumber, licensesTable.issuingAuthority],
    orderBy: licensesTable.expiryDate,
    coerceWrite: (v) => applyIntCoercion(v, ["level"]),
    importSupported: false,
    label: "License",
  },
};

function getConfig(name: string): TableConfig | null {
  return tables[name] ?? null;
}

// ---- Routes ----------------------------------------------------------------

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
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const sortField = typeof req.query.sort === "string" ? req.query.sort : "";
  const sortDir = req.query.dir === "asc" ? "asc" : "desc";

  const where = search && cfg.searchColumns.length > 0
    ? or(...cfg.searchColumns.map((c) => ilike(sql`${c}::text`, `%${search}%`)))
    : undefined;

  const sortColumn = sortField && (cfg.table as any)[sortField] ? (cfg.table as any)[sortField] : cfg.orderBy;
  const order = sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [rows, totalRows] = await Promise.all([
    db.select().from(cfg.table).where(where).orderBy(order).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(cfg.table).where(where),
  ]);

  res.json({ rows, total: totalRows[0]?.count ?? 0, limit, offset });
});

router.post("/admin/tables/:table", requireAdmin, async (req, res): Promise<void> => {
  const tableName = String(req.params.table);
  const cfg = getConfig(tableName);
  if (!cfg) {
    res.status(404).json({ error: "Not Found", message: `Unknown table '${tableName}'` });
    return;
  }
  const parsed = cfg.insertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation",
      message: `${cfg.label} validation failed`,
      issues: parsed.error.issues,
    });
    return;
  }
  let values = cfg.coerceWrite(parsed.data as Record<string, unknown>);
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
  } else {
    body = cfg.coerceWrite(body);
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
    const updated = (await db.update(cfg.table).set(body).where(eq((cfg.table as any).id, id)).returning()) as unknown[];
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "Not Found", message: `${cfg.label} not found` });
      return;
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

  type RowResult = { index: number; ok: boolean; id?: string; error?: string };
  const results: RowResult[] = [];

  // Validate everything first so we don't insert partial data
  const validated: { index: number; values: Record<string, unknown> }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const parsed = cfg.insertSchema.safeParse(r);
    if (!parsed.success) {
      results.push({
        index: i,
        ok: false,
        error: parsed.error.issues.map((x: z.core.$ZodIssue) => `${x.path.join(".")}: ${x.message}`).join("; "),
      });
      continue;
    }
    let values = cfg.coerceWrite(parsed.data as Record<string, unknown>);
    if (cfg.beforeInsert) values = await cfg.beforeInsert(values);
    validated.push({ index: i, values });
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
  res.status(201).json({ inserted, failed, total: rows.length, results });
});

export default router;
