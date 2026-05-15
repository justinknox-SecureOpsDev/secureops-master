import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, ilike, and, sql } from "drizzle-orm";
import { db, usersTable, employeesTable, licensesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

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
  const empValues: Record<string, unknown> = { userId: user.id };
  for (const k of ALL_EMP_PASSTHROUGH_KEYS) {
    if (body[k] !== undefined) empValues[k] = body[k];
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

router.put("/employees/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const body = req.body as Record<string, unknown>;

  const isAdmin = req.user!.role === "admin";

  const userUpdates: Record<string, unknown> = {};
  if (typeof body.firstName === "string") userUpdates.firstName = body.firstName;
  if (typeof body.lastName === "string") userUpdates.lastName = body.lastName;
  if (typeof body.status === "string" && isAdmin) userUpdates.status = body.status;

  // Non-admin self-edits are restricted to a narrow allow-list. HR / payroll
  // / compliance / document fields require admin role, even when the actor
  // is editing their own row.
  const allowedKeys = isAdmin ? ALL_EMP_PASSTHROUGH_KEYS : SELF_UPDATABLE_EMP_KEYS;
  const empUpdates: Record<string, unknown> = {};
  for (const k of allowedKeys) {
    if (body[k] !== undefined) empUpdates[k] = body[k];
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

export default router;
