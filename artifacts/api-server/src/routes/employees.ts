import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, ilike, and, sql, desc } from "drizzle-orm";
import { db, usersTable, employeesTable, licensesTable, employeeChangesTable } from "@workspace/db";
import { requireAuth, requireAdmin, verifyToken } from "../middlewares/auth";
import type { Request, Response, NextFunction } from "express";
import { buildEmployeeProfilePdf } from "../lib/profilePdf";
import { writeEmployeeFieldChanges, CHANGE_FIELD_LABELS } from "../lib/employeeChangeLog";

const router: IRouter = Router();

/**
 * Lightweight auth shim for the profile-PDF download route only.
 *
 * The full `requireAuth` only accepts an `Authorization: Bearer …`
 * header, which works for `fetch()` in the admin portal but not for the
 * mobile app, where the cleanest way to surface a PDF to the user is
 * `Linking.openURL(...)` into the system browser — which can't set
 * custom headers.
 *
 * We therefore allow the same JWT to come in via `?token=` as a fallback,
 * mirroring the WebSocket upgrade in `lib/wsManager.ts` (which has the
 * same constraint). All the production hardening still applies: tokens
 * are signed JWTs with TTL, the live user row is re-read (revocation
 * check happens in the route handler below via `req.user`), and the
 * route is otherwise a read-only download.
 */
function requireAuthOrQueryToken(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization?.startsWith("Bearer ")) {
    requireAuth(req, res, next);
    return;
  }
  const q = req.query.token;
  const token = typeof q === "string"
    ? q
    : Array.isArray(q) && typeof q[0] === "string"
      ? q[0]
      : undefined;
  if (!token) {
    res.status(401).json({ error: "Unauthorized", message: "No token provided" });
    return;
  }
  try {
    verifyToken(token);
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
    return;
  }
  // Re-use the canonical auth pipeline (status/revocation/mustChangePassword)
  // by synthesizing the standard Authorization header and delegating.
  req.headers.authorization = `Bearer ${token}`;
  requireAuth(req, res, next);
}

/**
 * Shared `select` projection for the Employee API contract — must stay in
 * sync with `Employee` in `lib/api-spec/openapi.yaml`. Includes every
 * applicant + onboarding field that gets mirrored onto the employees row
 * (right-to-work, TX licence, references, banking, uniform, consents,
 * source-link IDs).
 */
const employeeSelect = {
  id: usersTable.id,
  userId: usersTable.id,
  email: usersTable.email,
  firstName: usersTable.firstName,
  lastName: usersTable.lastName,
  role: usersTable.role,
  status: usersTable.status,
  createdAt: usersTable.createdAt,
  // Login activity — surfaced to admins so the personnel list can render
  // an "online now" dot and a "NEW" pill for freshly-active officers.
  lastActiveAt: usersTable.lastActiveAt,
  firstLoginAt: usersTable.firstLoginAt,
  lastLoginAt: usersTable.lastLoginAt,
  // Contact / identity
  phone: employeesTable.phone,
  address: employeesTable.address,
  dateOfBirth: employeesTable.dateOfBirth,
  cityOfBirth: employeesTable.cityOfBirth,
  stateOfBirth: employeesTable.stateOfBirth,
  niNumber: employeesTable.niNumber,
  // Right to work
  rightToWorkStatus: employeesTable.rightToWorkStatus,
  rightToWorkDocKey: employeesTable.rightToWorkDocKey,
  // TX security licence
  siaLicenseNumber: employeesTable.siaLicenseNumber,
  siaLicenseLevel: employeesTable.siaLicenseLevel,
  siaLicenseExpiry: employeesTable.siaLicenseExpiry,
  licenseDocKey: employeesTable.licenseDocKey,
  passportDocKey: employeesTable.passportDocKey,
  // Experience
  previousExperience: employeesTable.previousExperience,
  yearsExperience: employeesTable.yearsExperience,
  references: employeesTable.references,
  // Personal docs
  photoKey: employeesTable.photoKey,
  cvKey: employeesTable.cvKey,
  trainingCertificateKeys: employeesTable.trainingCertificateKeys,
  availability: employeesTable.availability,
  // Emergency contact
  emergencyContactName: employeesTable.emergencyContactName,
  emergencyContactRelationship: employeesTable.emergencyContactRelationship,
  emergencyContactPhone: employeesTable.emergencyContactPhone,
  // Pay & banking
  hourlyRate: employeesTable.hourlyRate,
  bankAccountName: employeesTable.bankAccountName,
  bankAccountNumber: employeesTable.bankAccountNumber,
  bankBsb: employeesTable.bankBsb,
  taxCode: employeesTable.taxCode,
  payStubDocKey: employeesTable.payStubDocKey,
  // Uniform
  uniformShirt: employeesTable.uniformShirt,
  uniformTrousers: employeesTable.uniformTrousers,
  uniformJacket: employeesTable.uniformJacket,
  uniformBoots: employeesTable.uniformBoots,
  // Consents
  directDepositConsent: employeesTable.directDepositConsent,
  directDepositSignature: employeesTable.directDepositSignature,
  acknowledgements: employeesTable.acknowledgements,
  // HR pipeline links
  applicationId: employeesTable.applicationId,
  onboardingSubmissionId: employeesTable.onboardingSubmissionId,
  skills: employeesTable.skills,
};

/**
 * Fields an employee may update on their *own* row. Deliberately narrow:
 * basic contact info + emergency contact + uniform sizes. Everything HR/
 * payroll/compliance/document-related stays admin-only (see
 * `ADMIN_ONLY_EMP_KEYS` below).
 */
const SELF_UPDATABLE_EMP_KEYS = [
  "phone", "address",
  "emergencyContactName", "emergencyContactRelationship", "emergencyContactPhone",
  "uniformShirt", "uniformTrousers", "uniformJacket", "uniformBoots",
] as const;

/**
 * Admin-only employee fields: identity, right-to-work, TX licence,
 * experience, references, personal documents, banking, tax, consents,
 * skills, plus the freeform `availability` / `acknowledgements` JSON blobs.
 *
 * `hourlyRate` is special-cased (numeric → string) below.
 */
const ADMIN_ONLY_EMP_KEYS = [
  "dateOfBirth", "cityOfBirth", "stateOfBirth", "niNumber",
  "rightToWorkStatus", "rightToWorkDocKey",
  "siaLicenseNumber", "siaLicenseLevel", "siaLicenseExpiry", "licenseDocKey", "passportDocKey",
  "previousExperience", "yearsExperience", "references",
  "photoKey", "cvKey", "trainingCertificateKeys", "availability",
  "bankAccountName", "bankAccountNumber", "bankBsb", "taxCode", "payStubDocKey",
  "directDepositConsent", "directDepositSignature", "acknowledgements",
  "skills",
] as const;

const ALL_EMP_PASSTHROUGH_KEYS = [
  ...SELF_UPDATABLE_EMP_KEYS,
  ...ADMIN_ONLY_EMP_KEYS,
] as const;


router.get("/employees", requireAdmin, async (req, res): Promise<void> => {
  const { status, search } = req.query as { status?: string; search?: string };

  let query = db
    .select(employeeSelect)
    .from(usersTable)
    .leftJoin(employeesTable, eq(usersTable.id, employeesTable.userId));

  const conditions = [];
  if (status) conditions.push(eq(usersTable.status, status));
  if (search) {
    conditions.push(
      sql`(${ilike(usersTable.firstName, `%${search}%`)} OR ${ilike(usersTable.lastName, `%${search}%`)} OR ${ilike(usersTable.email, `%${search}%`)})`
    );
  }

  const rows = conditions.length > 0
    ? await query.where(and(...conditions))
    : await query;

  const licenseCountsRaw = await db
    .select({
      employeeId: licensesTable.employeeId,
      total: sql<number>`count(*)::int`,
      expiringSoon: sql<number>`count(*) filter (where ${licensesTable.expiryDate} <= current_date + interval '30 days' and ${licensesTable.expiryDate} >= current_date)::int`,
      maxLevel: sql<number | null>`max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date)`,
    })
    .from(licensesTable)
    .groupBy(licensesTable.employeeId);

  const licenseMap = new Map(licenseCountsRaw.map((r) => [r.employeeId, r]));

  const employees = rows.map((r) => {
    const lc = licenseMap.get(r.id);
    return {
      ...r,
      licenseCount: lc?.total ?? 0,
      expiringLicenseCount: lc?.expiringSoon ?? 0,
      maxLicenseLevel: lc?.maxLevel ?? null,
    };
  });

  res.json(employees);
});

router.post("/employees", requireAdmin, async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const { email, password, firstName, lastName, role } = body as {
    email?: string; password?: string; firstName?: string; lastName?: string; role?: string;
  };
  if (!email || !password || !firstName || !lastName) {
    res.status(400).json({ error: "Bad Request", message: "email, password, firstName, lastName required" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(usersTable).values({
    email: email.toLowerCase(),
    passwordHash,
    firstName,
    lastName,
    role: role || "employee",
    status: "active",
  }).returning();

  // Build employee insert payload from the same allow-list used by PUT, so
  // POST /employees accepts the full expanded CreateEmployeeRequest contract.
  // Allow-list iteration: `k` only ranges over the hardcoded
  // ALL_EMP_PASSTHROUGH_KEYS constant, never user input. Object.hasOwn
  // additionally guards against prototype-chain reads from `body`.
  const empValues: Record<string, unknown> = { userId: user.id };
  for (const k of ALL_EMP_PASSTHROUGH_KEYS) {
    if (Object.hasOwn(body, k) && body[k] !== undefined) {
      // nosemgrep: javascript.express.security.audit.remote-property-injection
      empValues[k] = body[k];
    }
  }
  if (body.hourlyRate !== undefined) {
    empValues.hourlyRate = body.hourlyRate === null ? null : String(body.hourlyRate);
  }
  if (empValues.skills === undefined) empValues.skills = [];
  await db.insert(employeesTable).values(empValues as typeof employeesTable.$inferInsert);

  // Re-read via the canonical projection so the response shape matches
  // GET /employees/:id and the OpenAPI Employee schema exactly.
  const [row] = await db
    .select(employeeSelect)
    .from(usersTable)
    .leftJoin(employeesTable, eq(usersTable.id, employeesTable.userId))
    .where(eq(usersTable.id, user.id));

  res.status(201).json({
    ...row,
    licenseCount: 0,
    expiringLicenseCount: 0,
    maxLicenseLevel: null,
  });
});

router.get("/employees/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [row] = await db
    .select(employeeSelect)
    .from(usersTable)
    .leftJoin(employeesTable, eq(usersTable.id, employeesTable.userId))
    .where(eq(usersTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Not Found", message: "Employee not found" });
    return;
  }

  const licenseCountsRaw = await db
    .select({
      total: sql<number>`count(*)::int`,
      expiringSoon: sql<number>`count(*) filter (where ${licensesTable.expiryDate} <= current_date + interval '30 days' and ${licensesTable.expiryDate} >= current_date)::int`,
      maxLevel: sql<number | null>`max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date)`,
    })
    .from(licensesTable)
    .where(eq(licensesTable.employeeId, id));

  res.json({
    ...row,
    licenseCount: licenseCountsRaw[0]?.total ?? 0,
    expiringLicenseCount: licenseCountsRaw[0]?.expiringSoon ?? 0,
    maxLicenseLevel: licenseCountsRaw[0]?.maxLevel ?? null,
  });
});

/**
 * Download a branded WCSG officer profile PDF.
 *
 * Authorization mirrors `GET /employees/:id`: admins can pull any
 * employee, employees can only pull themselves. Bank account /
 * routing / SSN are masked in the PDF builder itself.
 */
router.get("/employees/:id/profile/pdf", requireAuthOrQueryToken, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const payload = await buildEmployeeProfilePdf(id);
  if (!payload) { res.status(404).json({ error: "Not Found", message: "Employee not found" }); return; }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  payload.stream.pipe(res);
});

/** Convenience self-route for the mobile app. */
router.get("/me/profile/pdf", requireAuthOrQueryToken, async (req, res): Promise<void> => {
  const payload = await buildEmployeeProfilePdf(req.user!.userId);
  if (!payload) { res.status(404).json({ error: "Not Found", message: "Profile not found" }); return; }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  payload.stream.pipe(res);
});

router.put("/employees/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const body = req.body as Record<string, unknown>;

  const isAdmin = req.user!.role === "admin";

  // Snapshot the row BEFORE writes so we can diff field-by-field and
  // populate the employee_changes log. We need both the user-level cols
  // (firstName/lastName/status) and the employees-level cols.
  const [beforeRow] = await db
    .select(employeeSelect)
    .from(usersTable)
    .leftJoin(employeesTable, eq(usersTable.id, employeesTable.userId))
    .where(eq(usersTable.id, id));

  const userUpdates: Record<string, unknown> = {};
  if (typeof body.firstName === "string") userUpdates.firstName = body.firstName;
  if (typeof body.lastName === "string") userUpdates.lastName = body.lastName;
  if (typeof body.status === "string" && isAdmin) userUpdates.status = body.status;

  // Non-admin self-edits are restricted to a narrow allow-list. HR / payroll
  // / compliance / document fields require admin role, even when the actor
  // is editing their own row.
  // Allow-list iteration: `k` only ranges over hardcoded constants
  // (ALL_EMP_PASSTHROUGH_KEYS / SELF_UPDATABLE_EMP_KEYS), never user input.
  // Object.hasOwn additionally guards against prototype-chain reads.
  const allowedKeys = isAdmin ? ALL_EMP_PASSTHROUGH_KEYS : SELF_UPDATABLE_EMP_KEYS;
  const empUpdates: Record<string, unknown> = {};
  for (const k of allowedKeys) {
    if (Object.hasOwn(body, k) && body[k] !== undefined) {
      // nosemgrep: javascript.express.security.audit.remote-property-injection
      empUpdates[k] = body[k];
    }
  }
  if (isAdmin && body.hourlyRate !== undefined) {
    empUpdates.hourlyRate = body.hourlyRate === null ? null : String(body.hourlyRate);
  }

  if (Object.keys(userUpdates).length > 0) {
    await db.update(usersTable).set(userUpdates).where(eq(usersTable.id, id));
  }
  if (Object.keys(empUpdates).length > 0) {
    await db.update(employeesTable).set(empUpdates).where(eq(employeesTable.userId, id));
  }

  const [row] = await db
    .select(employeeSelect)
    .from(usersTable)
    .leftJoin(employeesTable, eq(usersTable.id, employeesTable.userId))
    .where(eq(usersTable.id, id));

  await writeEmployeeFieldChanges({
    employeeUserId: id,
    keys: [...Object.keys(userUpdates), ...Object.keys(empUpdates)],
    before: beforeRow as Record<string, unknown> | undefined,
    after: row as Record<string, unknown> | undefined,
    actor: { userId: req.user!.userId, email: req.user!.email, role: req.user!.role },
    log: req.log,
  });

  const lc = await db
    .select({
      total: sql<number>`count(*)::int`,
      expiringSoon: sql<number>`count(*) filter (where ${licensesTable.expiryDate} <= current_date + interval '30 days' and ${licensesTable.expiryDate} >= current_date)::int`,
      maxLevel: sql<number | null>`max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date)`,
    })
    .from(licensesTable)
    .where(eq(licensesTable.employeeId, id));

  res.json({
    ...row,
    licenseCount: lc[0]?.total ?? 0,
    expiringLicenseCount: lc[0]?.expiringSoon ?? 0,
    maxLicenseLevel: lc[0]?.maxLevel ?? null,
  });
});

/**
 * GET /employees/:id/changes
 *
 * Recent profile change history for one employee. Admin can read any
 * employee's log; non-admin callers may only read their own. Defaults to
 * the most recent 20 rows; `limit` capped at 100.
 */
router.get("/employees/:id/changes", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const limitRaw = parseInt(String((req.query as Record<string, string>).limit ?? "20"), 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

  const rows = await db
    .select()
    .from(employeeChangesTable)
    .where(eq(employeeChangesTable.employeeUserId, id))
    .orderBy(desc(employeeChangesTable.changedAt))
    .limit(limit);

  res.json({
    rows: rows.map((r) => ({
      ...r,
      fieldLabel: CHANGE_FIELD_LABELS[r.field] ?? r.field,
    })),
  });
});

export default router;
