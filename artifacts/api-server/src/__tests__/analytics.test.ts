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
// Wide range covering client A's week (03-02..08) AND client B's week
// (03-09..15) — used to prove the clientId filter separates the two.
const WIDE_START = "2009-03-02";
const WIDE_END = "2009-03-15";
const B_WEEK_START = "2009-03-09";
const B_WEEK_END = "2009-03-15";

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
  clientBId: string;
  siteBId: string;
  clientCId: string;
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

  // ── Client B: separate client/site with data in the FOLLOWING week ──
  // (keeps the original single-week assertions above untouched while
  // letting the wide-range tests prove the clientId filter separates them)
  const [clientB] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client-b`, paymentTermsDays: 30 })
    .returning({ id: clientsTable.id });
  ctx.clientBId = clientB.id;

  const [siteB] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientBId,
      name: `${TAG}-site-b`,
      address: "200 Analytics Way",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteBId = siteB.id;

  await db.insert(invoicesTable).values({
    invoiceNumber: `${TAG}-INV-B`,
    clientId: ctx.clientBId,
    siteId: ctx.siteBId,
    clientName: `${TAG}-client-b`,
    periodStart: B_WEEK_START,
    periodEnd: B_WEEK_END,
    subtotal: "400.00",
    totalAmount: "400.00",
    status: "draft",
    dueDate: "2009-04-08",
  });

  await db.insert(payrollEntriesTable).values({
    employeeId: ctx.officerBId,
    siteId: ctx.siteBId,
    periodStart: B_WEEK_START,
    periodEnd: B_WEEK_END,
    totalHours: "4.00",
    hourlyRate: "25.00",
    grossPay: "100.00",
    netPay: "100.00",
    status: "pending",
  });

  // ── Client C: a client with NO sites at all ──
  const [clientC] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client-c`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientCId = clientC.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM incidents WHERE title LIKE ${TAG + "%"}`);
  await db.execute(
    sql`DELETE FROM time_entries WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM payroll_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM payroll_entries WHERE site_id = ${ctx.siteBId}::uuid`);
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

  it("400 on a malformed clientId", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: RANGE_START, end: RANGE_END, clientId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/clientId/);
  });

  it("404 on an unknown clientId", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: RANGE_START, end: RANGE_END, clientId: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Client not found/);
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

    // Trends: everything seeded falls in the week of Mon 2009-03-02, which is
    // ISO week 2009-W10. Revenue/labor (date-only periodStart), hours (SQL
    // timezone-aware date_trunc) and incidents must all land in the SAME
    // bucket — a mismatch here means periodStart dates are being re-interpreted
    // through a timezone again.
    expect(b.pnlTrend).toEqual([
      { bucket: "2009-W10", revenue: 500, laborCost: 300, profit: 200 },
    ]);
    expect(b.hoursTrend).toEqual([{ bucket: "2009-W10", worked: 8, scheduled: 24 }]);
    expect(b.incidentTrend).toEqual([{ bucket: "2009-W10", count: 1 }]);

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

describe("GET /analytics/summary — clientId filter", () => {
  it("wide range without a filter includes both clients", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: WIDE_START, end: WIDE_END });
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(900); // 500 (A) + 400 (B)
    expect(res.body.laborCost).toBe(400); // 300 (A) + 100 (B)
    const siteIds = res.body.perSite.map((s: any) => s.siteId);
    expect(siteIds).toContain(ctx.siteId);
    expect(siteIds).toContain(ctx.siteBId);
  });

  it("filters every section to client A only", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: WIDE_START, end: WIDE_END, clientId: ctx.clientId });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.revenue).toBe(500);
    expect(b.laborCost).toBe(300);
    expect(b.profit).toBe(200);
    expect(b.hoursWorked).toBe(8);
    expect(b.hoursScheduled).toBe(24);
    expect(b.noShowCount).toBe(1);
    expect(b.unfilledCount).toBe(1);
    expect(b.incidentTotal).toBe(1);
    // Trend totals reconcile with the filtered aggregates
    const trendRevenue = b.pnlTrend.reduce((s: number, r: any) => s + r.revenue, 0);
    const trendLabor = b.pnlTrend.reduce((s: number, r: any) => s + r.laborCost, 0);
    expect(trendRevenue).toBe(500);
    expect(trendLabor).toBe(300);
    // Per-site list contains ONLY client A's site
    expect(b.perSite.map((s: any) => s.siteId)).toEqual([ctx.siteId]);
    expect(b.missedShifts.every((m: any) => m.siteId === ctx.siteId)).toBe(true);
  });

  it("filters to client B only (no operational data, just financials)", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: WIDE_START, end: WIDE_END, clientId: ctx.clientBId });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.revenue).toBe(400);
    expect(b.laborCost).toBe(100);
    expect(b.hoursWorked).toBe(0);
    expect(b.hoursScheduled).toBe(0);
    expect(b.noShowCount).toBe(0);
    expect(b.incidentTotal).toBe(0);
    expect(b.perSite.map((s: any) => s.siteId)).toEqual([ctx.siteBId]);
  });

  it("a client with no sites yields an all-zero summary", async () => {
    const res = await request(app)
      .get("/api/analytics/summary")
      .set(authed(ctx.adminToken))
      .query({ start: WIDE_START, end: WIDE_END, clientId: ctx.clientCId });
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(0);
    expect(res.body.laborCost).toBe(0);
    expect(res.body.hoursWorked).toBe(0);
    expect(res.body.incidentTotal).toBe(0);
    expect(res.body.perSite).toEqual([]);
  });
});

describe("analytics exports — clientId filter", () => {
  it("CSV export includes the client slug in the filename and a Client row", async () => {
    const res = await request(app)
      .get("/api/analytics/export.csv")
      .set(authed(ctx.adminToken))
      .query({ start: WIDE_START, end: WIDE_END, clientId: ctx.clientId });
    expect(res.status).toBe(200);
    const slug = `${TAG}-client`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="wcsg-analytics-${slug}-${WIDE_START}_${WIDE_END}.csv"`,
    );
    expect(res.text).toContain(`Client,${TAG}-client`);
    expect(res.text).toContain("Revenue (USD),500.00");
    expect(res.text).not.toContain(`${TAG}-site-b`);
  });

  it("CSV export without a client keeps the original filename", async () => {
    const res = await request(app)
      .get("/api/analytics/export.csv")
      .set(authed(ctx.adminToken))
      .query({ start: RANGE_START, end: RANGE_END });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="wcsg-analytics-${RANGE_START}_${RANGE_END}.csv"`,
    );
    expect(res.text).not.toContain("\r\nClient,");
  });

  it("CSV export 404s on an unknown clientId", async () => {
    const res = await request(app)
      .get("/api/analytics/export.csv")
      .set(authed(ctx.adminToken))
      .query({ start: RANGE_START, end: RANGE_END, clientId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it("PDF export includes the client slug in the filename", async () => {
    const res = await request(app)
      .get("/api/analytics/export.pdf")
      .set(authed(ctx.adminToken))
      .query({ start: WIDE_START, end: WIDE_END, clientId: ctx.clientBId })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const slugB = `${TAG}-client-b`;
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="wcsg-analytics-${slugB}-${WIDE_START}_${WIDE_END}.pdf"`,
    );
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
