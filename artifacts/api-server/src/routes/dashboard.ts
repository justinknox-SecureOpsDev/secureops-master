import { Router, type IRouter } from "express";
import { eq, and, isNull, gte, lte, sql, ne, inArray } from "drizzle-orm";
import { db, usersTable, shiftsTable, incidentsTable, payrollEntriesTable, licensesTable, timeEntriesTable, shiftAssignmentsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/dashboard/admin-summary", requireAdmin, async (req, res): Promise<void> => {
  const [totalEmp] = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable);
  const [activeEmp] = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.status, "active"));
  const [pendingEmp] = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.status, "pending"));
  const [activeShifts] = await db.select({ count: sql<number>`count(*)::int` }).from(shiftsTable).where(eq(shiftsTable.status, "active"));
  const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [upcomingShifts] = await db.select({ count: sql<number>`count(*)::int` }).from(shiftsTable).where(and(
    eq(shiftsTable.status, "upcoming"),
    lte(shiftsTable.startTime, sevenDays),
  ));
  const [openIncidents] = await db.select({ count: sql<number>`count(*)::int` }).from(incidentsTable).where(ne(incidentsTable.status, "closed"));
  const [criticalIncidents] = await db.select({ count: sql<number>`count(*)::int` }).from(incidentsTable).where(and(eq(incidentsTable.severity, "critical"), ne(incidentsTable.status, "closed")));
  const [pendingPayroll] = await db.select({ count: sql<number>`count(*)::int` }).from(payrollEntriesTable).where(eq(payrollEntriesTable.status, "pending"));
  const [expiringLicenses] = await db.select({ count: sql<number>`count(*)::int` }).from(licensesTable).where(
    and(gte(licensesTable.expiryDate, sql`current_date`), lte(licensesTable.expiryDate, sql`current_date + interval '30 days'`))
  );
  const [clockedIn] = await db.select({ count: sql<number>`count(*)::int` }).from(timeEntriesTable).where(isNull(timeEntriesTable.clockOutTime));

  const recentIncidents = await db
    .select({
      id: incidentsTable.id,
      shiftId: incidentsTable.shiftId,
      employeeId: incidentsTable.employeeId,
      title: incidentsTable.title,
      description: incidentsTable.description,
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      locationDescription: incidentsTable.locationDescription,
      lat: incidentsTable.lat,
      lng: incidentsTable.lng,
      occurredAt: incidentsTable.occurredAt,
      resolvedAt: incidentsTable.resolvedAt,
      adminNotes: incidentsTable.adminNotes,
      createdAt: incidentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      shiftTitle: shiftsTable.title,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(incidentsTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .orderBy(sql`${incidentsTable.createdAt} desc`)
    .limit(5);

  const upcomingShiftsList = await db
    .select()
    .from(shiftsTable)
    .where(eq(shiftsTable.status, "upcoming"))
    .orderBy(shiftsTable.startTime)
    .limit(5);

  res.json({
    totalEmployees: totalEmp.count,
    activeEmployees: activeEmp.count,
    pendingEmployees: pendingEmp.count,
    activeShifts: activeShifts.count,
    upcomingShifts: upcomingShifts.count,
    openIncidents: openIncidents.count,
    criticalIncidents: criticalIncidents.count,
    pendingPayroll: pendingPayroll.count,
    expiringLicenses: expiringLicenses.count,
    clockedInNow: clockedIn.count,
    recentIncidents,
    upcomingShiftsList: upcomingShiftsList.map((s) => ({ ...s, assignments: [] })),
  });
});

router.get("/dashboard/employee-summary", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [hoursWeek] = await db
    .select({ total: sql<number>`coalesce(sum(${timeEntriesTable.hoursWorked}::numeric), 0)::float` })
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, userId), gte(timeEntriesTable.clockInTime, weekStart)));

  const [hoursMonth] = await db
    .select({ total: sql<number>`coalesce(sum(${timeEntriesTable.hoursWorked}::numeric), 0)::float` })
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, userId), gte(timeEntriesTable.clockInTime, monthStart)));

  const [activeEntry] = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, userId), isNull(timeEntriesTable.clockOutTime)));

  const assignedShifts = await db
    .select({ shiftId: shiftAssignmentsTable.shiftId })
    .from(shiftAssignmentsTable)
    .where(and(eq(shiftAssignmentsTable.employeeId, userId), eq(shiftAssignmentsTable.status, "accepted")));

  const shiftIds = assignedShifts.map((r) => r.shiftId);
  let upcomingShifts: typeof shiftsTable.$inferSelect[] = [];
  if (shiftIds.length > 0) {
    upcomingShifts = await db
      .select()
      .from(shiftsTable)
      .where(and(
        inArray(shiftsTable.id, shiftIds),
        eq(shiftsTable.status, "upcoming"),
        gte(shiftsTable.startTime, now),
        lte(shiftsTable.startTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      ))
      .orderBy(shiftsTable.startTime)
      .limit(5);
  }

  const pendingAssignments = await db
    .select({
      id: shiftAssignmentsTable.id,
      shiftId: shiftAssignmentsTable.shiftId,
      employeeId: shiftAssignmentsTable.employeeId,
      status: shiftAssignmentsTable.status,
      createdAt: shiftAssignmentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(shiftAssignmentsTable)
    .leftJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id))
    .where(and(eq(shiftAssignmentsTable.employeeId, userId), eq(shiftAssignmentsTable.status, "pending")));

  const [openIncidents] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(incidentsTable)
    .where(and(eq(incidentsTable.employeeId, userId), ne(incidentsTable.status, "closed")));

  const [expiringLicenses] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(licensesTable)
    .where(
      and(
        eq(licensesTable.employeeId, userId),
        gte(licensesTable.expiryDate, sql`current_date`),
        lte(licensesTable.expiryDate, sql`current_date + interval '30 days'`)
      )
    );

  const nextShift = upcomingShifts[0] ? { ...upcomingShifts[0], assignments: [] } : null;

  res.json({
    nextShift,
    activeTimeEntry: activeEntry || null,
    hoursThisWeek: hoursWeek.total,
    hoursThisMonth: hoursMonth.total,
    upcomingShifts: upcomingShifts.map((s) => ({ ...s, assignments: [] })),
    pendingAssignments,
    myOpenIncidents: openIncidents.count,
    expiringLicenses: expiringLicenses.count,
  });
});

export default router;
