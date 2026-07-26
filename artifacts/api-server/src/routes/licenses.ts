import { Router, type IRouter } from "express";
import { eq, and, sql, lte, gte, desc } from "drizzle-orm";
import { db, licensesTable, usersTable, employeesTable } from "@workspace/db";
import { requireStaff, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function getLicenseStatus(expiryDate: string): string {
  const expiry = new Date(expiryDate);
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (expiry < now) return "expired";
  if (expiry <= thirtyDaysFromNow) return "expiring_soon";
  return "valid";
}

// The employees.siaLicense* columns are the denormalized "Licence" summary the
// admin OfficerProfile and the profile PDF actually render — they do NOT read
// the licenses table. So any create/edit of a license must refresh that
// snapshot from the officer's ACTIVE license (the one with the latest expiry),
// or the profile keeps showing stale onboarding-time values. Keyed on
// employees.userId because licenses.employeeId holds a users.id (same id space).
async function syncEmployeeActiveLicense(tx: Tx, employeeId: string): Promise<void> {
  const [active] = await tx
    .select({
      level: licensesTable.level,
      licenseNumber: licensesTable.licenseNumber,
      expiryDate: licensesTable.expiryDate,
      docKey: licensesTable.docKey,
    })
    .from(licensesTable)
    .where(eq(licensesTable.employeeId, employeeId))
    .orderBy(desc(licensesTable.expiryDate), desc(licensesTable.createdAt))
    .limit(1);
  if (!active) return; // no licenses left → leave the existing snapshot untouched
  await tx
    .update(employeesTable)
    .set({
      siaLicenseNumber: active.licenseNumber,
      siaLicenseLevel: active.level,
      siaLicenseExpiry: active.expiryDate,
      // Only carry a card photo forward when the active license has one; never
      // blank an existing photo just because this row lacks a scan.
      ...(active.docKey ? { licenseDocKey: active.docKey } : {}),
    })
    .where(eq(employeesTable.userId, employeeId));
}

router.get("/licenses", requireStaff, async (req, res): Promise<void> => {
  const { employeeId, status } = req.query as { employeeId?: string; status?: string };
  const conditions = [];
  if (req.user!.role !== "admin") {
    conditions.push(eq(licensesTable.employeeId, req.user!.userId));
  } else if (employeeId) {
    conditions.push(eq(licensesTable.employeeId, employeeId));
  }

  if (status === "valid") {
    conditions.push(gte(licensesTable.expiryDate, sql`current_date + interval '30 days'`));
  } else if (status === "expiring_soon") {
    conditions.push(gte(licensesTable.expiryDate, sql`current_date`));
    conditions.push(lte(licensesTable.expiryDate, sql`current_date + interval '30 days'`));
  } else if (status === "expired") {
    conditions.push(lte(licensesTable.expiryDate, sql`current_date`));
  }

  const rows = await db
    .select({
      id: licensesTable.id,
      employeeId: licensesTable.employeeId,
      type: licensesTable.type,
      level: licensesTable.level,
      licenseNumber: licensesTable.licenseNumber,
      issuingAuthority: licensesTable.issuingAuthority,
      issueDate: licensesTable.issueDate,
      expiryDate: licensesTable.expiryDate,
      notes: licensesTable.notes,
      createdAt: licensesTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(licensesTable)
    .leftJoin(usersTable, eq(licensesTable.employeeId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows.map((r) => ({ ...r, status: getLicenseStatus(r.expiryDate) })));
});

router.post("/licenses", requireStaff, async (req, res): Promise<void> => {
  const { employeeId, type, level, licenseNumber, issuingAuthority, issueDate, expiryDate, notes } = req.body;
  if (!employeeId || !type || !licenseNumber || !expiryDate) {
    res.status(400).json({ error: "Bad Request", message: "employeeId, type, licenseNumber, expiryDate required" });
    return;
  }
  if (req.user!.role !== "admin" && req.user!.userId !== employeeId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const lvl = level != null && [1, 2, 3, 4].includes(Number(level)) ? Number(level) : null;
  const license = await db.transaction(async (tx) => {
    const [lic] = await tx.insert(licensesTable).values({
      employeeId,
      type,
      level: lvl,
      licenseNumber,
      issuingAuthority: issuingAuthority || null,
      issueDate: issueDate || null,
      expiryDate,
      notes: notes || null,
    }).returning();
    // Refresh the officer-profile licence snapshot from the active license.
    await syncEmployeeActiveLicense(tx, employeeId);
    return lic;
  });

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));
  res.status(201).json({
    ...license,
    status: getLicenseStatus(license.expiryDate),
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

router.put("/licenses/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { type, level, licenseNumber, issuingAuthority, issueDate, expiryDate, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (type) updates.type = type;
  if (level !== undefined) updates.level = level == null ? null : ([1, 2, 3, 4].includes(Number(level)) ? Number(level) : null);
  if (licenseNumber) updates.licenseNumber = licenseNumber;
  if (issuingAuthority !== undefined) updates.issuingAuthority = issuingAuthority;
  if (issueDate !== undefined) updates.issueDate = issueDate;
  if (expiryDate) updates.expiryDate = expiryDate;
  if (notes !== undefined) updates.notes = notes;

  const license = await db.transaction(async (tx) => {
    const [lic] = await tx.update(licensesTable).set(updates).where(eq(licensesTable.id, id)).returning();
    if (!lic) return null;
    // Editing a license can change which one is active (e.g. a new expiry),
    // so refresh the officer-profile licence snapshot too.
    await syncEmployeeActiveLicense(tx, lic.employeeId);
    return lic;
  });
  if (!license) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, license.employeeId));
  res.json({
    ...license,
    status: getLicenseStatus(license.expiryDate),
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

export default router;
