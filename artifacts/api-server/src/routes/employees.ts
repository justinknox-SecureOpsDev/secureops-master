import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, ilike, and, sql } from "drizzle-orm";
import { db, usersTable, employeesTable, licensesTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/employees", requireAdmin, async (req, res): Promise<void> => {
  const { status, search } = req.query as { status?: string; search?: string };

  let query = db
    .select({
      id: usersTable.id,
      userId: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      phone: employeesTable.phone,
      address: employeesTable.address,
      emergencyContactName: employeesTable.emergencyContactName,
      emergencyContactPhone: employeesTable.emergencyContactPhone,
      hourlyRate: employeesTable.hourlyRate,
      bankAccountName: employeesTable.bankAccountName,
      bankAccountNumber: employeesTable.bankAccountNumber,
      bankBsb: employeesTable.bankBsb,
      skills: employeesTable.skills,
    })
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
    };
  });

  res.json(employees);
});

router.post("/employees", requireAdmin, async (req, res): Promise<void> => {
  const { email, password, firstName, lastName, role, phone, address, emergencyContactName, emergencyContactPhone, hourlyRate, bankAccountName, bankAccountNumber, bankBsb, skills } = req.body;
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

  const [employee] = await db.insert(employeesTable).values({
    userId: user.id,
    phone: phone || null,
    address: address || null,
    emergencyContactName: emergencyContactName || null,
    emergencyContactPhone: emergencyContactPhone || null,
    hourlyRate: hourlyRate ? String(hourlyRate) : null,
    bankAccountName: bankAccountName || null,
    bankAccountNumber: bankAccountNumber || null,
    bankBsb: bankBsb || null,
    skills: skills || [],
  }).returning();

  res.status(201).json({
    id: user.id,
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    phone: employee.phone,
    address: employee.address,
    emergencyContactName: employee.emergencyContactName,
    emergencyContactPhone: employee.emergencyContactPhone,
    hourlyRate: employee.hourlyRate,
    bankAccountName: employee.bankAccountName,
    bankAccountNumber: employee.bankAccountNumber,
    bankBsb: employee.bankBsb,
    skills: employee.skills,
    licenseCount: 0,
    expiringLicenseCount: 0,
  });
});

router.get("/employees/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [row] = await db
    .select({
      id: usersTable.id,
      userId: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      phone: employeesTable.phone,
      address: employeesTable.address,
      emergencyContactName: employeesTable.emergencyContactName,
      emergencyContactPhone: employeesTable.emergencyContactPhone,
      hourlyRate: employeesTable.hourlyRate,
      bankAccountName: employeesTable.bankAccountName,
      bankAccountNumber: employeesTable.bankAccountNumber,
      bankBsb: employeesTable.bankBsb,
      skills: employeesTable.skills,
    })
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
    })
    .from(licensesTable)
    .where(eq(licensesTable.employeeId, id));

  res.json({
    ...row,
    licenseCount: licenseCountsRaw[0]?.total ?? 0,
    expiringLicenseCount: licenseCountsRaw[0]?.expiringSoon ?? 0,
  });
});

router.put("/employees/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (req.user!.role !== "admin" && req.user!.userId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const { firstName, lastName, phone, status, address, emergencyContactName, emergencyContactPhone, hourlyRate, bankAccountName, bankAccountNumber, bankBsb, skills } = req.body;

  const userUpdates: Record<string, unknown> = {};
  if (firstName) userUpdates.firstName = firstName;
  if (lastName) userUpdates.lastName = lastName;
  if (status && req.user!.role === "admin") userUpdates.status = status;

  const empUpdates: Record<string, unknown> = {};
  if (phone !== undefined) empUpdates.phone = phone;
  if (address !== undefined) empUpdates.address = address;
  if (emergencyContactName !== undefined) empUpdates.emergencyContactName = emergencyContactName;
  if (emergencyContactPhone !== undefined) empUpdates.emergencyContactPhone = emergencyContactPhone;
  if (hourlyRate !== undefined) empUpdates.hourlyRate = String(hourlyRate);
  if (bankAccountName !== undefined) empUpdates.bankAccountName = bankAccountName;
  if (bankAccountNumber !== undefined) empUpdates.bankAccountNumber = bankAccountNumber;
  if (bankBsb !== undefined) empUpdates.bankBsb = bankBsb;
  if (skills !== undefined) empUpdates.skills = skills;

  if (Object.keys(userUpdates).length > 0) {
    await db.update(usersTable).set(userUpdates).where(eq(usersTable.id, id));
  }
  if (Object.keys(empUpdates).length > 0) {
    await db.update(employeesTable).set(empUpdates).where(eq(employeesTable.userId, id));
  }

  const [row] = await db
    .select({
      id: usersTable.id,
      userId: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      phone: employeesTable.phone,
      address: employeesTable.address,
      emergencyContactName: employeesTable.emergencyContactName,
      emergencyContactPhone: employeesTable.emergencyContactPhone,
      hourlyRate: employeesTable.hourlyRate,
      bankAccountName: employeesTable.bankAccountName,
      bankAccountNumber: employeesTable.bankAccountNumber,
      bankBsb: employeesTable.bankBsb,
      skills: employeesTable.skills,
    })
    .from(usersTable)
    .leftJoin(employeesTable, eq(usersTable.id, employeesTable.userId))
    .where(eq(usersTable.id, id));

  res.json({ ...row, licenseCount: 0, expiringLicenseCount: 0 });
});

export default router;
