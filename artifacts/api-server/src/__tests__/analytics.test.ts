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
  payrollEntriesTable,
  invoicesTable,
  incidentsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `analytics-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Fixed, far-past date range so aggregates are not polluted by demo data or
// other test suites (which all seed around the current week). 2009-03-02 is
// a Monday; the whole seeded week is 2009-03-02 .. 2009-03-08.
const RANGE_START = "2009-03-02";
const RANGE_END = "2009-03-08";
// A different far-past range guaranteed to contain no rows at all.
const EMPTY_START = "2003-01-05";
const EMPTY_END = "2003-01-11";

type Ctx = {
  adminId: string;
  employeeId: string;
  officerAId: string;
  officerBId: string;
  adminToken: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

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

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Shift: 9am–5pm US Central on Wed 2009-03-04 (Central = UTC-6 in March
// before DST switch on Mar 8). 15:00Z–23:00Z, 8 hours, headcount 3.
const shiftStart = new Date("2009-03-04T15:00:00.000Z");
const shiftEnd = new Date("2009-03-04T23:00:00.000Z");

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.employeeId = await makeUser("employee", "emp");
  ctx.officerAId = await makeUser("employee", "officer-a");
  ctx.officerBId = await makeUser("employee", "officer-b");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
  ctx.employeeToken = signToken({
    userId: ctx.employeeId,
    email: `${TAG}-emp@example.test`,
    role: "employee",
  });

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
      address: "100 Analytics Way",
      defaultBillRate: "40.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // Past shift, headcount 3: officer A works it (approved time entry),
  // officer B accepts but never clocks in (no-show), third slot never
  // filled (unfilled shift).
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 3,
      status: "upcoming",
      payRate: "25.00",
      billRate: "40.00",
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  await db.insert(shiftAssignmentsTable).values([
    { shiftId: ctx.shiftId, employeeId: ctx.officerAId, status: "accepted" },
    { shiftId: ctx.shiftId, employeeId: ctx.officerBId, status: "accepted" },
  ]);

  await db.insert(timeEntriesTable).values({
    shiftId: ctx.shiftId,
    employeeId: ctx.officerAId,
    siteId: ctx.siteId,
    clockInTime: shiftStart,
    clockOutTime: shiftEnd,
    hoursWorked: "8.00",
    approvalStatus: "approved",
  });

  await db.insert(invoicesTable).values({
    invoiceNumber: `${TAG}-INV-1`,
    clientId: ctx.clientId,
    siteId: ctx.siteId,
    clientName: `${TAG}-client`,
    periodStart: RANGE_START,
    periodEnd: RANGE_END,
    subtotal: "500.00",
    totalAmount: "500.00",
    status: "draft",
    dueDate: "2009-03-22",
  });

  await db.insert(payrollEntriesTable).values({
    employeeId: ctx.officerAId,
    siteId: ctx.siteId,
    periodStart: RANGE_START,
    periodEnd: RANGE_END,
    totalHours: "8.00",
    hourlyRate: "25.00",
    grossPay: "300.00",
    netPay: "300.00",
    status: "pending",
  });

  await db.insert(incidentsTable).values({
    shiftId: ctx.shiftId,
    employeeId: ctx.officerAId,
    title: `${TAG}-incident`,
    description: "Test incident for analytics aggregation",
    severity: "high",
    status: "open",
    occurredAt: new Date("2009-03-04T16:30:00.000Z"),
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM incidents WHERE title LIKE ${TAG + "%"}`);
  await db.execute(
    sql`DELETE FROM time_entries WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM payroll_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM invoices WHERE invoice_number LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("GET /analytics/summary — auth & validation", () => {
  it("rejects unauthenticated requests (401)", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .query({ start: RANGE_START, end: RANGE_END });
    expect(res.status).toBe(401);
  });

  it("rejects non-admin employees (403)", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.employeeToken))
      .query({ start: RANGE_START, end: RANGE_END });
    expect(res.status).toBe(403);
  });

  it("400 when start is missing", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ end: RANGE_END });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  it("400 when end is missing", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: RANGE_START });
    expect(res.status).toBe(400);
  });

  it("400 when both params are missing", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(400);
  });

  it("400 on malformed dates (US format)", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: "03/02/2009", end: "03/08/2009" });
    expect(res.status).toBe(400);
  });

  it("400 on non-zero-padded dates", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: "2009-3-2", end: RANGE_END });
    expect(res.status).toBe(400);
  });
});

describe("GET /analytics/summary — empty range", () => {
  it("returns zeros (not an error) when the range has no data", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: EMPTY_START, end: EMPTY_END });
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(0);
    expect(res.body.laborCost).toBe(0);
    expect(res.body.profit).toBe(0);
    expect(res.body.marginPct).toBe(0);
    expect(res.body.hoursWorked).toBe(0);
    expect(res.body.hoursScheduled).toBe(0);
    expect(res.body.coveragePct).toBe(0);
    expect(res.body.noShowCount).toBe(0);
    expect(res.body.unfilledCount).toBe(0);
    expect(res.body.missedShifts).toEqual([]);
    expect(res.body.incidentTotal).toBe(0);
    expect(res.body.incidentsBySeverity).toEqual({ low: 0, medium: 0, high: 0, critical: 0 });
    expect(res.body.incidentsByStatus).toEqual({ open: 0, investigating: 0, closed: 0 });
    expect(res.body.pnlTrend).toEqual([]);
    expect(res.body.hoursTrend).toEqual([]);
    expect(res.body.incidentTrend).toEqual([]);
    expect(res.body.perSite).toEqual([]);
  });
});

describe("GET /analytics/summary — seeded week", () => {
  it("returns the full response shape with correct aggregates", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: RANGE_START, end: RANGE_END });
    expect(res.status).toBe(200);
    const b = res.body;

    // P&L
    expect(b.revenue).toBe(500);
    expect(b.laborCost).toBe(300);
    expect(b.profit).toBe(200);
    expect(b.marginPct).toBeCloseTo(40, 5);

    // Hours: 8h worked, 8h * headcount 3 = 24h scheduled
    expect(b.hoursWorked).toBe(8);
    expect(b.hoursScheduled).toBe(24);
    expect(b.coveragePct).toBeCloseTo((8 / 24) * 100, 5);

    // Missed-shift metrics: officer B no-showed, one headcount slot unfilled
    expect(b.noShowCount).toBe(1);
    expect(b.unfilledCount).toBe(1);
    expect(b.missedShifts).toHaveLength(1);
    const missed = b.missedShifts[0];
    expect(missed.shiftId).toBe(ctx.shiftId);
    expect(missed.siteId).toBe(ctx.siteId);
    expect(missed.siteName).toBe(`${TAG}-site`);
    expect(missed.headcount).toBe(3);
    expect(missed.filled).toBe(2);
    expect(missed.noShows).toBe(1);
    expect(missed.startTime).toBe(shiftStart.toISOString());
    expect(missed.endTime).toBe(shiftEnd.toISOString());

    // Incidents
    expect(b.incidentTotal).toBe(1);
    expect(b.incidentsBySeverity).toEqual({ low: 0, medium: 0, high: 1, critical: 0 });
    expect(b.incidentsByStatus).toEqual({ open: 1, investigating: 0, closed: 0 });

    // Trends: assert totals across buckets rather than exact bucket labels
    // (bucketing is timezone-sensitive; totals must always reconcile).
    expect(Array.isArray(b.pnlTrend)).toBe(true);
    expect(b.pnlTrend.length).toBeGreaterThan(0);
    const trendRevenue = b.pnlTrend.reduce((s: number, r: any) => s + r.revenue, 0);
    const trendLabor = b.pnlTrend.reduce((s: number, r: any) => s + r.laborCost, 0);
    const trendProfit = b.pnlTrend.reduce((s: number, r: any) => s + r.profit, 0);
    expect(trendRevenue).toBe(500);
    expect(trendLabor).toBe(300);
    expect(trendProfit).toBe(200);
    for (const row of b.pnlTrend) {
      expect(row.profit).toBeCloseTo(row.revenue - row.laborCost, 5);
      expect(typeof row.bucket).toBe("string");
      expect(row.bucket).toMatch(/^\d{4}-W\d{2}$/);
    }

    const trendWorked = b.hoursTrend.reduce((s: number, r: any) => s + r.worked, 0);
    const trendScheduled = b.hoursTrend.reduce((s: number, r: any) => s + r.scheduled, 0);
    expect(trendWorked).toBe(8);
    expect(trendScheduled).toBe(24);

    const trendIncidents = b.incidentTrend.reduce((s: number, r: any) => s + r.count, 0);
    expect(trendIncidents).toBe(1);

    // Per-site breakdown
    expect(Array.isArray(b.perSite)).toBe(true);
    const site = b.perSite.find((s: any) => s.siteId === ctx.siteId);
    expect(site).toBeTruthy();
    expect(site.siteName).toBe(`${TAG}-site`);
    expect(site.revenue).toBe(500);
    expect(site.laborCost).toBe(300);
    expect(site.profit).toBe(200);
    expect(site.hoursWorked).toBe(8);
    expect(site.hoursScheduled).toBe(24);
    expect(site.noShows).toBe(1);
    expect(site.unfilledShifts).toBe(1);
    expect(site.incidents).toBe(1);
  });

  it("handles a single-day range (start === end)", async () => {
    // 2009-03-04: the shift, time entry, and incident all fall on this
    // business day, but the invoice/payroll periodStart (Mon 03-02) do not.
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: "2009-03-04", end: "2009-03-04" });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.revenue).toBe(0);
    expect(b.laborCost).toBe(0);
    expect(b.hoursWorked).toBe(8);
    expect(b.hoursScheduled).toBe(24);
    expect(b.incidentTotal).toBe(1);
    expect(b.noShowCount).toBe(1);
    expect(b.missedShifts).toHaveLength(1);
  });

  it("excludes data just outside the range boundary", async () => {
    // Day before the shift: nothing operational should appear.
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: "2009-03-03", end: "2009-03-03" });
    expect(res.status).toBe(200);
    expect(res.body.hoursWorked).toBe(0);
    expect(res.body.hoursScheduled).toBe(0);
    expect(res.body.incidentTotal).toBe(0);
    expect(res.body.missedShifts).toEqual([]);
  });
});
