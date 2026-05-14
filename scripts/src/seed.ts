import bcrypt from "bcryptjs";
import { db, usersTable, employeesTable, shiftsTable, shiftAssignmentsTable, licensesTable, incidentsTable } from "@workspace/db";

async function seed() {
  const passwordHash = await bcrypt.hash("Admin123!", 10);
  const empHash = await bcrypt.hash("Employee123!", 10);

  const [admin] = await db.insert(usersTable).values({
    email: "admin@secureops.com",
    passwordHash,
    firstName: "Admin",
    lastName: "User",
    role: "admin",
    status: "active",
  }).onConflictDoUpdate({ target: usersTable.email, set: { passwordHash } }).returning();
  console.log("Admin:", admin.email, admin.id);

  await db.insert(employeesTable).values({
    userId: admin.id,
    phone: "+61400000000",
    hourlyRate: "45.00",
  }).onConflictDoNothing();

  const [emp] = await db.insert(usersTable).values({
    email: "john.smith@secureops.com",
    passwordHash: empHash,
    firstName: "John",
    lastName: "Smith",
    role: "employee",
    status: "active",
  }).onConflictDoUpdate({ target: usersTable.email, set: { passwordHash: empHash } }).returning();
  console.log("Employee:", emp.email, emp.id);

  await db.insert(employeesTable).values({
    userId: emp.id,
    phone: "+61411222333",
    address: "12 Security St, Melbourne VIC 3000",
    hourlyRate: "38.50",
    emergencyContactName: "Jane Smith",
    emergencyContactPhone: "+61422333444",
    skills: ["crowd control", "first aid", "CCTV"],
  }).onConflictDoNothing();

  const [shift] = await db.insert(shiftsTable).values({
    title: "Night Patrol - CBD",
    clientName: "Metro Shopping Centre",
    location: "123 Collins St, Melbourne VIC 3000",
    startTime: new Date(Date.now() + 2 * 3600000),
    endTime: new Date(Date.now() + 10 * 3600000),
    hourlyRate: "38.50",
    billableRate: "75.00",
    status: "upcoming",
    isRepeat: false,
    notes: "Standard night patrol. Check all entry points every 30 mins.",
  }).returning();
  console.log("Shift:", shift.id);

  await db.insert(shiftAssignmentsTable).values({
    shiftId: shift.id,
    employeeId: emp.id,
    status: "accepted",
  }).onConflictDoNothing();

  await db.insert(licensesTable).values({
    employeeId: emp.id,
    type: "Security Licence (Class 1)",
    licenseNumber: "SL-2024-98765",
    issuingAuthority: "Victoria Police",
    issueDate: "2024-01-15",
    expiryDate: "2026-01-15",
  }).onConflictDoNothing();

  await db.insert(incidentsTable).values({
    shiftId: shift.id,
    employeeId: emp.id,
    title: "Suspicious Person Reported",
    description: "Individual loitering near rear entrance for 20+ minutes. Approached and moved on without incident.",
    severity: "low",
    status: "open",
    locationDescription: "Rear entrance, Level B1",
    occurredAt: new Date(Date.now() - 24 * 3600000),
  }).onConflictDoNothing();

  console.log("Seeding complete!");
  process.exit(0);
}

seed().catch((e) => { console.error(e); process.exit(1); });
