import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
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

const TAG = `officer-history-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerId: string;
  adminToken: string;
  officerToken: string;
  siteId: string;
};
const ctx = {} as Ctx;

const DAY = 86400_000;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeShift(start: Date, end: Date): Promise<string> {
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift-${start.toISOString()}`,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      status: "upcoming",
      headcount: 1,
      payRate: "20.00",
      billRate: "40.00",
    })
    .returning({ id: shiftsTable.id });
  return shift.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
  ctx.officerToken = signToken({
    userId: ctx.officerId,
    email: `${TAG}-officer@example.test`,
    role: "employee",
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: client.id,
      name: `${TAG}-site`,
      address: "1 History Way",
      defaultBillRate: "40.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const now = Date.now();

  // Shift A: ended ~2 days ago, worked on time (clock-in exactly at start).
  const aStart = new Date(now - 2 * DAY - 8 * 3600_000);
  const aEnd = new Date(now - 2 * DAY);
  const shiftA = await makeShift(aStart, aEnd);
  await db.insert(shiftAssignmentsTable).values({
    shiftId: shiftA,
    employeeId: ctx.officerId,
    status: "accepted",
  });
  await db.insert(timeEntriesTable).values({
    employeeId: ctx.officerId,
    shiftId: shiftA,
    siteId: ctx.siteId,
    clockInTime: aStart,
    clockOutTime: aEnd,
    hoursWorked: "8.00",
    approvalStatus: "approved",
  });

  // Shift B: ended ~9 days ago (previous ISO week), accepted but never
  // clocked in → no-show for that week.
  const bStart = new Date(now - 9 * DAY - 8 * 3600_000);
  const bEnd = new Date(now - 9 * DAY);
  const shiftB = await makeShift(bStart, bEnd);
  await db.insert(shiftAssignmentsTable).values({
    shiftId: shiftB,
    employeeId: ctx.officerId,
    status: "accepted",
  });
});

describe("GET /api/analytics/officer-history", () => {
  it("requires admin", async () => {
    const anon = await request(app).get(
      `/api/analytics/officer-history?userId=${ctx.officerId}`,
    );
    expect(anon.status).toBe(401);
    const emp = await request(app)
      .get(`/api/analytics/officer-history?userId=${ctx.officerId}`)
      .set("Authorization", `Bearer ${ctx.officerToken}`);
    expect(emp.status).toBe(403);
  });

  it("validates parameters", async () => {
    const badId = await request(app)
      .get(`/api/analytics/officer-history?userId=not-a-uuid`)
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(badId.status).toBe(400);

    const badWeeks = await request(app)
      .get(`/api/analytics/officer-history?userId=${ctx.officerId}&weeks=99`)
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(badWeeks.status).toBe(400);

    const missing = await request(app)
      .get(`/api/analytics/officer-history?userId=${randomUUID()}`)
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(missing.status).toBe(404);
  });

  it("returns a weekly series with correct per-week metrics", async () => {
    const res = await request(app)
      .get(`/api/analytics/officer-history?userId=${ctx.officerId}&weeks=6`)
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(ctx.officerId);
    expect(res.body.weeks).toBe(6);
    expect(res.body.points).toHaveLength(6);

    // Empty weeks report null rates so charts can show gaps.
    const empty = res.body.points.filter(
      (p: { shiftsAssigned: number }) => p.shiftsAssigned === 0,
    );
    expect(empty.length).toBe(4);
    for (const p of empty) {
      expect(p.attendanceRate).toBeNull();
      expect(p.onTimeRate).toBeNull();
      expect(p.reliabilityScore).toBeNull();
    }

    // Two active weeks, chronological: no-show week then worked week.
    const active = res.body.points.filter(
      (p: { shiftsAssigned: number }) => p.shiftsAssigned > 0,
    );
    expect(active).toHaveLength(2);
    const [noShowWeek, workedWeek] = active;

    expect(noShowWeek.shiftsAssigned).toBe(1);
    expect(noShowWeek.shiftsCompleted).toBe(0);
    expect(noShowWeek.noShows).toBe(1);
    expect(noShowWeek.attendanceRate).toBe(0);
    expect(noShowWeek.punctualityEligible).toBe(0);
    expect(noShowWeek.onTimeRate).toBeNull();
    // Mirrors the summary-table convention: with no completed shifts the
    // punctuality term defaults to 100, so 0.6*0 + 0.4*100 = 40.
    expect(noShowWeek.reliabilityScore).toBe(40);

    expect(workedWeek.shiftsAssigned).toBe(1);
    expect(workedWeek.shiftsCompleted).toBe(1);
    expect(workedWeek.noShows).toBe(0);
    expect(workedWeek.attendanceRate).toBe(100);
    expect(workedWeek.punctualityEligible).toBe(1);
    expect(workedWeek.onTimeRate).toBe(100);
    expect(workedWeek.reliabilityScore).toBe(100);
    expect(workedWeek.hoursWorked).toBeCloseTo(8, 1);

    // Buckets are ISO week labels in ascending order.
    const buckets = res.body.points.map((p: { bucket: string }) => p.bucket);
    expect(buckets.every((b: string) => /^\d{4}-W\d{2}$/.test(b))).toBe(true);
    expect([...buckets].sort()).toEqual(buckets);
  });
});
