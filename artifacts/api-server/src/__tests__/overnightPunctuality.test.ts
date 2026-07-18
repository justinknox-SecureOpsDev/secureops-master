import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Regression tests: officer-performance punctuality for shifts that span
 * midnight. The punctuality calculation in routes/analytics.ts compares
 * time_entries.clock_in_time against shifts.start_time (+ 5-minute grace) as
 * absolute timestamps, so a clock-in on the NEXT calendar day of an overnight
 * shift must still yield the correct minutes-late value. These tests pin that
 * behavior so a future refactor (e.g. to calendar-day-based bucketing) can't
 * silently break it.
 */

const TAG = `overnight-punct-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Fixed far-past week so aggregates are never polluted by demo data or other
// suites (which seed around the current week). Business timezone is US
// Central; April 2009 is CDT (UTC-5). Week of Mon 2009-03-30 .. Sun 2009-04-05.
const RANGE_START = "2009-03-30";
const RANGE_END = "2009-04-05";

// ── Shift 1: 22:00 → 06:00 US Central, Wed Apr 1 → Thu Apr 2 2009 ──
// 22:00 CDT = 03:00Z next UTC day; the shift spans local midnight.
const shift1Start = new Date("2009-04-02T03:00:00.000Z"); // Wed 22:00 Central
const shift1End = new Date("2009-04-02T11:00:00.000Z"); // Thu 06:00 Central

// ── Shift 2: 23:55 → 07:55 US Central, Fri Apr 3 → Sat Apr 4 2009 ──
// Chosen so that a slightly-late clock-in falls on the NEXT local calendar
// day (crossing local midnight between scheduled start and clock-in).
const shift2Start = new Date("2009-04-04T04:55:00.000Z"); // Fri 23:55 Central
const shift2End = new Date("2009-04-04T12:55:00.000Z"); // Sat 07:55 Central

type Ctx = {
  adminId: string;
  adminToken: string;
  clientId: string;
  siteId: string;
  shift1Id: string;
  shift2Id: string;
  onTimeId: string; // clocks in exactly at shift 1 start
  lateTenId: string; // clocks in 10 min after shift 1 start (22:10, pre-midnight)
  lateAcrossMidnightId: string; // clocks in 10 min after shift 2 start (00:05 next day)
  graceAcrossMidnightId: string; // clocks in exactly 5 min after shift 2 start (00:00 next day)
};
const ctx = {} as Ctx;

async function makeUser(suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role: suffix === "admin" ? "admin" : "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function hours(a: Date, b: Date): string {
  return ((b.getTime() - a.getTime()) / 3_600_000).toFixed(2);
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
  ctx.onTimeId = await makeUser("ontime");
  ctx.lateTenId = await makeUser("late-ten");
  ctx.lateAcrossMidnightId = await makeUser("late-midnight");
  ctx.graceAcrossMidnightId = await makeUser("grace-midnight");

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "1 Overnight Way",
      defaultBillRate: "40.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift1] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift-1`,
      siteId: ctx.siteId,
      startTime: shift1Start,
      endTime: shift1End,
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      payRate: "25.00",
      billRate: "40.00",
    })
    .returning({ id: shiftsTable.id });
  ctx.shift1Id = shift1.id;

  const [shift2] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift-2`,
      siteId: ctx.siteId,
      startTime: shift2Start,
      endTime: shift2End,
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      payRate: "25.00",
      billRate: "40.00",
    })
    .returning({ id: shiftsTable.id });
  ctx.shift2Id = shift2.id;

  await db.insert(shiftAssignmentsTable).values([
    { shiftId: ctx.shift1Id, employeeId: ctx.onTimeId, status: "accepted" },
    { shiftId: ctx.shift1Id, employeeId: ctx.lateTenId, status: "accepted" },
    { shiftId: ctx.shift2Id, employeeId: ctx.lateAcrossMidnightId, status: "accepted" },
    { shiftId: ctx.shift2Id, employeeId: ctx.graceAcrossMidnightId, status: "accepted" },
  ]);

  // Clock-in scenarios (all absolute UTC instants):
  const lateTenClockIn = new Date("2009-04-02T03:10:00.000Z"); // 22:10 Central — 10 min late, same local day as start
  const lateMidnightClockIn = new Date("2009-04-04T05:05:00.000Z"); // 00:05 Central Sat — 10 min late, NEXT local day
  const graceMidnightClockIn = new Date("2009-04-04T05:00:00.000Z"); // 00:00 Central Sat — exactly 5 min, inside grace, NEXT local day

  await db.insert(timeEntriesTable).values([
    {
      shiftId: ctx.shift1Id,
      employeeId: ctx.onTimeId,
      siteId: ctx.siteId,
      clockInTime: shift1Start,
      clockOutTime: shift1End,
      hoursWorked: hours(shift1Start, shift1End),
      approvalStatus: "approved",
    },
    {
      shiftId: ctx.shift1Id,
      employeeId: ctx.lateTenId,
      siteId: ctx.siteId,
      clockInTime: lateTenClockIn,
      clockOutTime: shift1End,
      hoursWorked: hours(lateTenClockIn, shift1End),
      approvalStatus: "approved",
    },
    {
      shiftId: ctx.shift2Id,
      employeeId: ctx.lateAcrossMidnightId,
      siteId: ctx.siteId,
      clockInTime: lateMidnightClockIn,
      clockOutTime: shift2End,
      hoursWorked: hours(lateMidnightClockIn, shift2End),
      approvalStatus: "approved",
    },
    {
      shiftId: ctx.shift2Id,
      employeeId: ctx.graceAcrossMidnightId,
      siteId: ctx.siteId,
      clockInTime: graceMidnightClockIn,
      clockOutTime: shift2End,
      hoursWorked: hours(graceMidnightClockIn, shift2End),
      approvalStatus: "approved",
    },
  ]);
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM time_entries WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

async function fetchPerOfficer() {
  const res = await request(app)
    .get("/api/analytics/summary")
    .set({ Authorization: `Bearer ${ctx.adminToken}` })
    .query({ start: RANGE_START, end: RANGE_END, clientId: ctx.clientId });
  expect(res.status).toBe(200);
  return res.body.perOfficer as Array<{
    userId: string;
    shiftsAssigned: number;
    shiftsCompleted: number;
    noShows: number;
    onTimeRate: number;
    avgMinutesLate: number;
    reliabilityScore: number;
    hoursWorked: number;
  }>;
}

describe("officer punctuality — overnight shifts (spanning midnight)", () => {
  it("clock-in exactly at the scheduled start of a 22:00–06:00 shift is on time", async () => {
    const perOfficer = await fetchPerOfficer();
    const row = perOfficer.find((r) => r.userId === ctx.onTimeId);
    expect(row).toBeTruthy();
    expect(row!.shiftsAssigned).toBe(1);
    expect(row!.shiftsCompleted).toBe(1);
    expect(row!.noShows).toBe(0);
    expect(row!.onTimeRate).toBe(100);
    expect(row!.avgMinutesLate).toBe(0);
    // Full 8 hours worked across the midnight boundary
    expect(row!.hoursWorked).toBeCloseTo(8, 1);
    // 60% attendance (100) + 40% punctuality (100)
    expect(row!.reliabilityScore).toBe(100);
  });

  it("clocking in 10 minutes late on a 22:00–06:00 shift reports exactly 10 minutes", async () => {
    const perOfficer = await fetchPerOfficer();
    const row = perOfficer.find((r) => r.userId === ctx.lateTenId);
    expect(row).toBeTruthy();
    expect(row!.shiftsCompleted).toBe(1);
    expect(row!.onTimeRate).toBe(0);
    expect(row!.avgMinutesLate).toBe(10);
    // 60% attendance (100) + 40% punctuality (0)
    expect(row!.reliabilityScore).toBe(60);
  });

  it("a 10-minute-late clock-in on the NEXT calendar day (23:55 start, 00:05 clock-in) reports 10 minutes, not a day's worth", async () => {
    const perOfficer = await fetchPerOfficer();
    const row = perOfficer.find((r) => r.userId === ctx.lateAcrossMidnightId);
    expect(row).toBeTruthy();
    expect(row!.shiftsCompleted).toBe(1);
    expect(row!.onTimeRate).toBe(0);
    // The regression this guards: if lateness were ever computed from
    // calendar dates / time-of-day instead of absolute timestamps, this
    // would report ~1430 minutes (or a negative value) instead of 10.
    expect(row!.avgMinutesLate).toBe(10);
    expect(row!.reliabilityScore).toBe(60);
  });

  it("a clock-in exactly 5 minutes after start, across midnight, stays inside the grace window", async () => {
    const perOfficer = await fetchPerOfficer();
    const row = perOfficer.find((r) => r.userId === ctx.graceAcrossMidnightId);
    expect(row).toBeTruthy();
    expect(row!.shiftsCompleted).toBe(1);
    // Grace is strictly "> start + 5 minutes", so exactly 5 minutes is on time
    expect(row!.onTimeRate).toBe(100);
    expect(row!.avgMinutesLate).toBe(0);
    expect(row!.reliabilityScore).toBe(100);
  });

  it("both overnight shifts land in the requested range (endTime-based bounds catch the post-midnight end)", async () => {
    const perOfficer = await fetchPerOfficer();
    const ourIds = [
      ctx.onTimeId,
      ctx.lateTenId,
      ctx.lateAcrossMidnightId,
      ctx.graceAcrossMidnightId,
    ];
    const rows = perOfficer.filter((r) => ourIds.includes(r.userId));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.shiftsAssigned === 1 && r.noShows === 0)).toBe(true);
  });
});
