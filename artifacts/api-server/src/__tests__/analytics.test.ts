/**
 * Analytics engine + endpoints.
 *
 * Correctness anchors:
 *   - Money mirrors invoicing/payroll (billRate→site default; payRateOverride
 *     → shift payRate → employee rate; both sides get the 1.5× holiday
 *     premium rounded to cents first).
 *   - Punctuality on an OVERNIGHT shift (23:00–07:00 local) is judged against
 *     the absolute shift-start instant + 5min grace: 22:55 punctual, 23:20
 *     late, 06:50 (next morning, before shift end!) still late.
 *   - No-shows / unfilled shifts are judged against the wall clock (injected
 *     `now`), never shift.status.
 *
 * All seeded data hangs off a TAG client and every compute call passes that
 * clientId, so parallel suites can't pollute these aggregates.
 */
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
  incidentsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import {
  computeAnalyticsSummary,
  computeAnalyticsOfficers,
  PUNCTUALITY_GRACE_MS,
} from "../lib/analytics";
import { startOfBusinessWeek, businessDateIso, businessDateToUtc } from "../lib/businessTime";

const TAG = `analytics-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);
const TZ = "America/Chicago";

// Week of Mon 2023-06-05 (no US federal holiday). The shift runs 23:00 Jun 5
// → 07:00 Jun 6 local (CDT, UTC-5): 04:00Z–12:00Z on Jun 6.
const SHIFT_START = new Date("2023-06-06T04:00:00.000Z");
const SHIFT_END = new Date("2023-06-06T12:00:00.000Z"); // 8h
const RANGE_START = businessDateToUtc("2023-06-05", TZ);
const RANGE_END = businessDateToUtc("2023-06-12", TZ); // exclusive
const NOW = new Date("2023-06-20T00:00:00.000Z"); // shift long over

type Ctx = {
  adminId: string;
  adminToken: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
  officerA: string; // 22:55 clock-in — punctual
  officerB: string; // 23:20 clock-in — late
  officerC: string; // 06:50 next morning — late (ad-hoc, no assignment)
  officerD: string; // accepted assignment, never clocked in — no-show
  officerE: string; // exactly start+grace — punctual (boundary)
  officerF: string; // clocked in but never clocked out — open entry on past shift
};
const ctx = {} as Ctx;

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
const range = () => ({ start: RANGE_START, end: RANGE_END, clientId: ctx.clientId, now: NOW });

beforeAll(async () => {
  const mkUser = async (role: "admin" | "employee", suffix: string, first: string) => {
    const [row] = await db
      .insert(usersTable)
      .values({
        email: `${TAG}-${suffix}@example.test`,
        passwordHash,
        firstName: first,
        lastName: TAG,
        role,
        status: "active",
        tokensValidAfter: new Date(0),
        // Analytics is company-owner gated (Task #733); the admin fixture
        // needs the flag exactly as the rollout backfill would grant it.
        isCompanyOwner: role === "admin",
      })
      .returning({ id: usersTable.id });
    return row.id;
  };
  ctx.adminId = await mkUser("admin", "admin", "Admin");
  ctx.officerA = await mkUser("employee", "a", "Alpha");
  ctx.officerB = await mkUser("employee", "b", "Bravo");
  ctx.officerC = await mkUser("employee", "c", "Charlie");
  ctx.officerD = await mkUser("employee", "d", "Delta");
  ctx.officerE = await mkUser("employee", "e", "Echo");
  ctx.officerF = await mkUser("employee", "f", "Foxtrot");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.employeeToken = signToken({ userId: ctx.officerA, email: `${TAG}-a@example.test`, role: "employee" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Analytics Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-overnight`,
      startTime: SHIFT_START,
      endTime: SHIFT_END,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 6, // 5 accepted below → 1 unfilled slot on an ended shift
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  await db.insert(shiftAssignmentsTable).values(
    [ctx.officerA, ctx.officerB, ctx.officerD, ctx.officerE, ctx.officerF].map((employeeId) => ({
      shiftId: ctx.shiftId,
      employeeId,
      status: "accepted",
    })),
  );

  const entry = (employeeId: string, clockIn: string, clockOut: string, hours: string) => ({
    shiftId: ctx.shiftId,
    siteId: ctx.siteId,
    employeeId,
    clockInTime: new Date(clockIn),
    clockOutTime: new Date(clockOut),
    hoursWorked: hours,
    approvalStatus: "approved" as const,
  });
  await db.insert(timeEntriesTable).values([
    // 22:55 local — 5min early → punctual.
    entry(ctx.officerA, "2023-06-06T03:55:00.000Z", "2023-06-06T12:00:00.000Z", "8.00"),
    // 23:20 local — 20min late → late.
    entry(ctx.officerB, "2023-06-06T04:20:00.000Z", "2023-06-06T12:00:00.000Z", "7.50"),
    // 06:50 local NEXT morning — inside the shift window but 7h50m after
    // start → late (overnight shifts judge against start, not the date).
    entry(ctx.officerC, "2023-06-06T11:50:00.000Z", "2023-06-06T12:00:00.000Z", "0.25"),
    // Exactly start + grace → still punctual (boundary is inclusive).
    entry(ctx.officerE, new Date(SHIFT_START.getTime() + PUNCTUALITY_GRACE_MS).toISOString(), "2023-06-06T08:05:00.000Z", "4.00"),
  ]);

  // officerF: open entry (no clockOut) on the already-ended shift — used by the
  // forgotten-clock-out regression test.
  await db.insert(timeEntriesTable).values({
    shiftId: ctx.shiftId,
    siteId: ctx.siteId,
    employeeId: ctx.officerF,
    clockInTime: SHIFT_START, // clocked in right at shift start
    clockOutTime: null,       // forgot to clock out
    hoursWorked: "0",         // stored value irrelevant — analytics recomputes from times
    approvalStatus: "approved",
  });

  await db.insert(incidentsTable).values({
    shiftId: ctx.shiftId,
    employeeId: ctx.officerA,
    title: `${TAG}-incident`,
    description: "Gate found unlocked",
    severity: "high",
    status: "open",
    occurredAt: new Date("2023-06-06T05:00:00.000Z"),
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM incidents WHERE title = ${`${TAG}-incident`}`);
  await db.execute(sql`DELETE FROM time_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM shift_assignments WHERE shift_id = ${ctx.shiftId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("business-week helpers", () => {
  it("startOfBusinessWeek walks back to Monday in the business timezone", () => {
    // Wed Jun 7 2023 18:00 local → Monday Jun 5.
    const wed = new Date("2023-06-07T23:00:00.000Z");
    expect(businessDateIso(startOfBusinessWeek(wed, TZ), TZ)).toBe("2023-06-05");
    // A Monday maps to itself.
    const mon = new Date("2023-06-05T12:00:00.000Z");
    expect(businessDateIso(startOfBusinessWeek(mon, TZ), TZ)).toBe("2023-06-05");
  });
});

describe("computeAnalyticsSummary", () => {
  it("prices hours like invoicing/payroll and aggregates staffing + incidents", async () => {
    const s = await computeAnalyticsSummary(range());

    // 8 + 7.5 + 0.25 + 4 = 19.75h @ bill 40 / pay 20.
    // Foxtrot's open entry contributes 0 to the summary (stored hoursWorked="0").
    expect(s.hoursWorked).toBe(19.75);
    expect(s.revenue).toBe(790);
    expect(s.laborCost).toBe(395);
    expect(s.pnl).toBe(395);
    expect(s.marginPct).toBe(50);

    // One 8h shift × headcount 6 = 48 scheduled hours.
    expect(s.hoursScheduled).toBe(48);
    expect(s.coveragePct).toBe(41.1); // 19.75 / 48

    // Delta accepted but never produced a time entry on the ended shift.
    expect(s.noShows).toBe(1);
    // 5 accepted < headcount 6 on an ended shift.
    expect(s.unfilledShifts).toBe(1);

    expect(s.incidents).toEqual({
      total: 1,
      low: 0,
      medium: 0,
      high: 1,
      critical: 0,
      open: 1,
      resolved: 0,
    });

    expect(s.weeklyTrend).toHaveLength(1);
    expect(s.weeklyTrend[0]).toMatchObject({
      weekStart: "2023-06-05",
      hoursWorked: 19.75,
      revenue: 790,
      laborCost: 395,
      pnl: 395,
      incidentCount: 1,
    });

    expect(s.sites).toHaveLength(1);
    expect(s.sites[0]).toMatchObject({
      siteId: ctx.siteId,
      siteName: `${TAG}-site`,
      revenue: 790,
      hoursWorked: 19.75,
      coveragePct: 41.1,
    });
  });

  it("treats a still-running shift as neither unfilled nor a no-show", async () => {
    // `now` BEFORE the shift ends: nothing has "ended", so no gaps yet.
    const s = await computeAnalyticsSummary({ ...range(), now: new Date("2023-06-06T05:00:00.000Z") });
    expect(s.noShows).toBe(0);
    expect(s.unfilledShifts).toBe(0);
  });
});

describe("computeAnalyticsOfficers — overnight punctuality", () => {
  it("judges punctuality against absolute shift start + 5min grace", async () => {
    const rows = await computeAnalyticsOfficers(range());
    const byName = new Map(rows.map((r) => [r.name.split(" ")[0], r]));

    // 22:55 clock-in (5min early) → punctual.
    expect(byName.get("Alpha")?.punctualityPct).toBe(100);
    // 23:20 clock-in (20min late) → late.
    expect(byName.get("Bravo")?.punctualityPct).toBe(0);
    // 06:50 next morning — before shift END but hours after start → late.
    expect(byName.get("Charlie")?.punctualityPct).toBe(0);
    // Exactly at start + grace → punctual (inclusive boundary).
    expect(byName.get("Echo")?.punctualityPct).toBe(100);
    // Never clocked in → no punctuality sample at all.
    expect(byName.has("Delta")).toBe(false);
  });

  it("aggregates hours, completed shifts, incidents and weekly trend per officer", async () => {
    const rows = await computeAnalyticsOfficers(range());
    // Sorted by hours desc. Foxtrot's open entry has stored hoursWorked="0",
    // so priceEntry returns 0h and Foxtrot sorts last.
    expect(rows.map((r) => r.name.split(" ")[0])).toEqual(["Alpha", "Bravo", "Echo", "Charlie", "Foxtrot"]);

    const alpha = rows[0]!;
    expect(alpha.hoursWorked).toBe(8);
    expect(alpha.shiftsCompleted).toBe(1); // ended shift + closed entry
    expect(alpha.incidentsFiled).toBe(1);
    expect(alpha.trend).toHaveLength(1);
    expect(alpha.trend[0]).toEqual({ weekStart: "2023-06-05", hoursWorked: 8 });
  });
});

describe("forgotten clock-out: hoursWorked bounded by shift endTime", () => {
  it("open entry on a past shift is capped at shift endTime in the per-officer performance query", async () => {
    // The per-officer performance SQL (loadPerOfficer, consumed by computeAnalyticsSummary)
    // used to read COALESCE(clockOut, NOW()), so Foxtrot's forgotten clock-out on the
    // 8h shift (ended 2023-06-06) would grow to ~(NOW - clockIn) >> 8h.
    // After the fix (LEAST(shiftEnd, NOW())), it must be exactly 8h.
    const s = await computeAnalyticsSummary(range());
    const foxtrot = s.perOfficer.find((r) => r.firstName === "Foxtrot");

    expect(foxtrot).toBeDefined();
    // Without the fix this would be thousands of hours (NOW() keeps growing).
    expect(foxtrot!.hoursWorked).toBeCloseTo(8, 1);
    expect(foxtrot!.hoursWorked).toBeLessThanOrEqual(8);
  });
});

describe("analytics endpoints", () => {
  const qs = `start=2023-06-05&end=2023-06-11&clientId=`;

  it("GET /analytics/summary requires admin", async () => {
    const anon = await request(app).get(`/api/analytics/summary?${qs}${ctx.clientId}`);
    expect(anon.status).toBe(401);
    const emp = await request(app)
      .get(`/api/analytics/summary?${qs}${ctx.clientId}`)
      .set(authed(ctx.employeeToken));
    expect(emp.status).toBe(403);
  });

  it("GET /analytics/summary returns the aggregate for admins", async () => {
    const res = await request(app)
      .get(`/api/analytics/summary?${qs}${ctx.clientId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(790);
    expect(res.body.weeklyTrend).toHaveLength(1);
  });

  it("GET /analytics/officers returns officer rows for admins", async () => {
    const res = await request(app)
      .get(`/api/analytics/officers?${qs}${ctx.clientId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].name).toContain("Alpha");
  });

  it("rejects malformed or inverted or oversized ranges", async () => {
    const bad = await request(app)
      .get("/api/analytics/summary?start=06/05/2023&end=2023-06-11")
      .set(authed(ctx.adminToken));
    expect(bad.status).toBe(400);

    const inverted = await request(app)
      .get("/api/analytics/summary?start=2023-06-11&end=2023-06-05")
      .set(authed(ctx.adminToken));
    expect(inverted.status).toBe(400);

    const oversized = await request(app)
      .get("/api/analytics/summary?start=2020-01-01&end=2023-06-11")
      .set(authed(ctx.adminToken));
    expect(oversized.status).toBe(400);
  });

  it("POST /admin/analytics/export-csv streams an escaped CSV", async () => {
    const res = await request(app)
      .post("/api/admin/analytics/export-csv")
      .set(authed(ctx.adminToken))
      .send({ start: "2023-06-05", end: "2023-06-11", clientId: ctx.clientId });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("Week of");
    expect(res.text).toContain("790.00");
    expect(res.text).toContain("Alpha");
  });

  it("POST /admin/analytics/export-pdf streams a PDF", async () => {
    const res = await request(app)
      .post("/api/admin/analytics/export-pdf")
      .set(authed(ctx.adminToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .send({ start: "2023-06-05", end: "2023-06-11", clientId: ctx.clientId });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
