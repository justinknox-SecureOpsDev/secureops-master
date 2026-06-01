import { eq } from "drizzle-orm";
import { db, employeeChangesTable, usersTable } from "@workspace/db";
import type { Logger } from "pino";

/**
 * Shared writer for `employee_changes` rows. Used by both:
 *  - `PUT /employees/:id` (admin OR self self-service edits)
 *  - `PUT /admin/tables/employees/:id` (admin spreadsheet UI)
 *
 * Diffs `before` vs `after` field-by-field using normalized compare,
 * masks sensitive fields, and bulk-inserts one row per actually-changed
 * field. Insert failures are logged and swallowed so the audit log is
 * never on the critical path of the user-facing write.
 */

const REDACTED_CHANGE_FIELDS = new Set<string>([
  "bankAccountNumber",
  "bankBsb",
  "niNumber",
  "directDepositSignature",
]);

export const CHANGE_FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  status: "Account status",
  email: "Email",
  phone: "Phone",
  address: "Address",
  dateOfBirth: "Date of birth",
  cityOfBirth: "City of birth",
  stateOfBirth: "State of birth",
  niNumber: "SSN (last 4)",
  rightToWorkStatus: "Right to work",
  rightToWorkDocKey: "Right-to-work document",
  siaLicenseNumber: "License number",
  siaLicenseLevel: "License level",
  siaLicenseExpiry: "License expiry",
  licenseDocKey: "License document",
  passportDocKey: "Passport document",
  previousExperience: "Previous experience",
  yearsExperience: "Years of experience",
  references: "References",
  photoKey: "Photo",
  cvKey: "Resume",
  trainingCertificateKeys: "Training certificates",
  availability: "Availability",
  emergencyContactName: "Emergency contact name",
  emergencyContactRelationship: "Emergency contact relationship",
  emergencyContactPhone: "Emergency contact phone",
  hourlyRate: "Hourly rate",
  bankAccountName: "Bank account name",
  bankAccountNumber: "Bank account number",
  bankBsb: "Routing / sort code",
  taxCode: "Tax code",
  payStubDocKey: "W-2 / pay stub",
  uniformShirt: "Uniform shirt size",
  uniformTrousers: "Uniform trouser size",
  uniformJacket: "Uniform jacket size",
  uniformBoots: "Uniform boots size",
  directDepositConsent: "Direct deposit consent",
  directDepositSignature: "Direct deposit signature",
  acknowledgements: "Policy acknowledgements",
  skills: "Skills",
  maxWeeklyHours: "Max weekly hours",
};

function normalizeForCompare(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try { return JSON.stringify(v); } catch { return String(v); }
}

function stringifyForLog(v: unknown, key: string): string | null {
  if (REDACTED_CHANGE_FIELDS.has(key)) {
    if (v === null || v === undefined || v === "") return null;
    const s = typeof v === "string" ? v : String(v);
    return s.length > 4 ? `••••${s.slice(-4)}` : "••••";
  }
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > 500 ? v.slice(0, 500) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  } catch { return String(v); }
}

export type ChangeLogActor = {
  userId: string;
  email?: string | null;
  role?: string | null;
};

/**
 * Compute and persist a per-field diff for `keys` between `before` and
 * `after`. Caller is responsible for picking which keys to consider — we
 * deliberately don't iterate all object keys so the log only reflects
 * fields the caller intended to update (and we never accidentally log
 * computed/derived columns).
 */
export async function writeEmployeeFieldChanges(opts: {
  employeeUserId: string;
  keys: string[];
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  actor: ChangeLogActor;
  log?: Logger;
}): Promise<void> {
  const { employeeUserId, keys, before, after, actor, log } = opts;
  if (!before || !after || keys.length === 0) return;

  const rows: Array<typeof employeeChangesTable.$inferInsert> = [];

  const [actorUser] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, actor.userId));
  const actorName = actorUser
    ? ([actorUser.firstName, actorUser.lastName].filter(Boolean).join(" ") || actorUser.email)
    : (actor.email ?? null);
  const source = actor.userId === employeeUserId ? "self" : "admin";

  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (normalizeForCompare(b) === normalizeForCompare(a)) continue;
    rows.push({
      employeeUserId,
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
      actorName,
      actorRole: actor.role ?? null,
      source,
      field: k,
      oldValue: stringifyForLog(b, k),
      newValue: stringifyForLog(a, k),
    });
  }
  if (rows.length === 0) return;
  try {
    await db.insert(employeeChangesTable).values(rows);
  } catch (err) {
    log?.error({ err, employeeUserId }, "failed to write employee_changes log");
  }
}
