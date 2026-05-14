import { Router, type IRouter } from "express";
import { eq, and, sql, lte, gte } from "drizzle-orm";
import { db, licensesTable, usersTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

function getLicenseStatus(expiryDate: string): string {
  const expiry = new Date(expiryDate);
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (expiry < now) return "expired";
  if (expiry <= thirtyDaysFromNow) return "expiring_soon";
  return "valid";
}

router.get("/licenses", requireAuth, async (req, res): Promise<void> => {
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

router.post("/licenses", requireAuth, async (req, res): Promise<void> => {
  const { employeeId, type, level, licenseNumber, issuingAuthority, issueDate, expiryDate, notes } = req.body;
  if (!employeeId || !type || !licenseNumber || !expiryDate) {
    res.status(400).json({ error: "Bad Request", message: "employeeId, type, licenseNumber, expiryDate required" });
    return;
  }
  if (req.user!.role !== "admin" && req.user!.userId !== employeeId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const lvl = level != null && [2, 3, 4].includes(Number(level)) ? Number(level) : null;
  const [license] = await db.insert(licensesTable).values({
    employeeId,
    type,
    level: lvl,
    licenseNumber,
    issuingAuthority: issuingAuthority || null,
    issueDate: issueDate || null,
    expiryDate,
    notes: notes || null,
  }).returning();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));
  res.status(201).json({
    ...license,
    status: getLicenseStatus(license.expiryDate),
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

router.put("/licenses/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { type, level, licenseNumber, issuingAuthority, issueDate, expiryDate, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (type) updates.type = type;
  if (level !== undefined) updates.level = level == null ? null : ([2, 3, 4].includes(Number(level)) ? Number(level) : null);
  if (licenseNumber) updates.licenseNumber = licenseNumber;
  if (issuingAuthority !== undefined) updates.issuingAuthority = issuingAuthority;
  if (issueDate !== undefined) updates.issueDate = issueDate;
  if (expiryDate) updates.expiryDate = expiryDate;
  if (notes !== undefined) updates.notes = notes;

  const [license] = await db.update(licensesTable).set(updates).where(eq(licensesTable.id, id)).returning();
  if (!license) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, license.employeeId));
  res.json({
    ...license,
    status: getLicenseStatus(license.expiryDate),
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

export default router;
