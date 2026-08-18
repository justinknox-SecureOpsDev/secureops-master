import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and, isNull } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  licensesTable,
  timeEntriesTable,
  shiftsTable,
  shiftAssignmentsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `autoclockin-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Remote South Atlantic coords far from any seed/real site so geo matching
// can only hit this suite's fixtures. Distinct from the clock-in suite's
// fixture coords to avoid cross-suite pollution under the full parallel run.
const SITE_LAT = -55.443322;
const SITE_LNG = -11.223344;
// ~0.5+ miles away at this latitude — outside the default 0.25mi radius but
// inside a generous per-site override.
const NEARBY_LAT = -55.443322;
const NEARBY_LNG = -11.209; // ≈0.56 mi east
// Hundreds of miles away — outside any sane radius.
const FAR_LAT = -50.0;
const FAR_LNG = -20.0;

type Ctx = {
  officerId: string;
  officerToken: string;
  clientId: string;
};
const ctx = {} as Ctx;

async function makeEmployee(suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeSite(opts: {
  name: string;
  autoClockInEnabled: boolean;
  geofenceRadiusMiles?: string | null;
  lat?: string | null;
  lng?: string | null;
}): Promise<string> {
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-${opts.name}`,
      address: "1 Auto Way",
      locationLat: opts.lat === undefined ? String(SITE_LAT) : opts.lat,
      locationLng: opts.lng === undefined ? String(SITE_LNG) : opts.lng,
      autoClockInEnabled: opts.autoClockInEnabled,
      geofenceRadiusMiles: opts.geofenceRadiusMiles ?? null,
    })
    .returning({ id: sitesTable.id });
  return site.id;
}

// Live shift (started 5 min ago, ends in 6h) with an accepted assignment.
async function makeLiveShiftWithAssignment(
  siteId: string,
  employeeId: string,
  requiredLicenseLevel = 1,
): Promise<string> {
  const start = new Date(Date.now() - 5 * 60_000);
  const end = new Date(Date.now() + 6 * 3600_000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId,
      title: `${TAG}-shift`,
      startTime: start,
      endTime: end,
      status: "upcoming",
      headcount: 1,
      requiredLicenseLevel,
    })
    .returning({ id: shiftsTable.id });
  await db.insert(shiftAssignmentsTable).values({
    shiftId: shift.id,
    employeeId,
    status: "accepted",
  });
  return shift.id;
}

async function cleanupScenario(employeeId: string, shiftId: string, siteId: string) {
  await db
    .delete(timeEntriesTable)
    .where(eq(timeEntriesTable.employeeId, employeeId));
  await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.shiftId, shiftId));
  await db.delete(shiftsTable).where(eq(shiftsTable.id, shiftId));
  await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function openEntries(employeeId: string) {
  return db
    .select({ id: timeEntriesTable.id })
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, employeeId), isNull(timeEntriesTable.clockOutTime)));
}

beforeAll(async () => {
  ctx.officerId = await makeEmployee("officer");
  ctx.officerToken = signToken({
    userId: ctx.officerId,
    email: `${TAG}-officer@example.test`,
    role: "employee",
  });
  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM licenses WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("POST /time-entries/auto-clock-in", () => {
  it("never triggers for a site with autoClockInEnabled=false, even with a perfect geofence + shift match", async () => {
    const siteId = await makeSite({ name: "optout", autoClockInEnabled: false });
    const shiftId = await makeLiveShiftWithAssignment(siteId, ctx.officerId);

    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: SITE_LAT, lng: SITE_LNG }); // exactly at the site
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(false);
    expect(res.body.reason).toBe("no_eligible_shift");
    expect(await openEntries(ctx.officerId)).toHaveLength(0);

    await cleanupScenario(ctx.officerId, shiftId, siteId);
  });

  it("does not clock in an officer outside the geofence radius (default radius)", async () => {
    const siteId = await makeSite({ name: "outside-default", autoClockInEnabled: true });
    const shiftId = await makeLiveShiftWithAssignment(siteId, ctx.officerId);

    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: FAR_LAT, lng: FAR_LNG });
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(false);
    expect(res.body.reason).toBe("outside_geofence");
    expect(await openEntries(ctx.officerId)).toHaveLength(0);

    await cleanupScenario(ctx.officerId, shiftId, siteId);
  });

  it("honours the per-site geofenceRadiusMiles override in both directions", async () => {
    // NEARBY point is ~0.56mi from the site: outside the 0.25mi default,
    // but inside a 2mi per-site override.

    // 1. No override → default radius → NOT clocked in from NEARBY.
    const tightSiteId = await makeSite({ name: "tight", autoClockInEnabled: true });
    const tightShiftId = await makeLiveShiftWithAssignment(tightSiteId, ctx.officerId);
    const resTight = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: NEARBY_LAT, lng: NEARBY_LNG });
    expect(resTight.body.triggered).toBe(false);
    expect(resTight.body.reason).toBe("outside_geofence");
    expect(await openEntries(ctx.officerId)).toHaveLength(0);
    await cleanupScenario(ctx.officerId, tightShiftId, tightSiteId);

    // 2. 2mi override → same point IS inside → clocked in.
    const wideSiteId = await makeSite({ name: "wide", autoClockInEnabled: true, geofenceRadiusMiles: "2.000" });
    const wideShiftId = await makeLiveShiftWithAssignment(wideSiteId, ctx.officerId);
    const resWide = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: NEARBY_LAT, lng: NEARBY_LNG });
    expect(resWide.body.triggered).toBe(true);
    expect(resWide.body.entry?.shiftId).toBe(wideShiftId);
    await cleanupScenario(ctx.officerId, wideShiftId, wideSiteId);
  });

  it("does not clock in an officer whose effective license level no longer meets the shift requirement", async () => {
    // Officer has NO licenses on file → effective level 1 (worker baseline).
    // The shift requires level 3 (e.g. licence lapsed after rostering).
    const siteId = await makeSite({ name: "lapsed", autoClockInEnabled: true });
    const shiftId = await makeLiveShiftWithAssignment(siteId, ctx.officerId, 3);

    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: SITE_LAT, lng: SITE_LNG }); // inside the geofence
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(false);
    expect(await openEntries(ctx.officerId)).toHaveLength(0);

    await cleanupScenario(ctx.officerId, shiftId, siteId);
  });

  it("returns { triggered: false, reason: 'already_clocked_in' } when an open entry exists, and creates no second entry", async () => {
    const siteId = await makeSite({ name: "alreadyopen", autoClockInEnabled: true });
    const shiftId = await makeLiveShiftWithAssignment(siteId, ctx.officerId);
    const [seeded] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        siteId,
        clockInTime: new Date(Date.now() - 3600_000),
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: SITE_LAT, lng: SITE_LNG });
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(false);
    expect(res.body.reason).toBe("already_clocked_in");

    const open = await openEntries(ctx.officerId);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(seeded.id);

    await cleanupScenario(ctx.officerId, shiftId, siteId);
  });

  it("serializes two concurrent calls — exactly one open entry, one triggered:true", async () => {
    const siteId = await makeSite({ name: "concurrent", autoClockInEnabled: true });
    const shiftId = await makeLiveShiftWithAssignment(siteId, ctx.officerId);

    const fire = () =>
      request(app)
        .post("/api/time-entries/auto-clock-in")
        .set(authed(ctx.officerToken))
        .send({ lat: SITE_LAT, lng: SITE_LNG });
    const [a, b] = await Promise.all([fire(), fire()]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const triggered = [a.body, b.body].filter((r) => r.triggered === true);
    const rejected = [a.body, b.body].filter((r) => r.triggered === false);
    expect(triggered).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("already_clocked_in");

    // The FOR UPDATE row lock must have prevented a second open entry.
    expect(await openEntries(ctx.officerId)).toHaveLength(1);

    await cleanupScenario(ctx.officerId, shiftId, siteId);
  });

  it("on success returns { triggered: true, entry }, flips the shift active, and stamps coords + the auto note", async () => {
    const siteId = await makeSite({ name: "success", autoClockInEnabled: true });
    const shiftId = await makeLiveShiftWithAssignment(siteId, ctx.officerId);

    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: SITE_LAT, lng: SITE_LNG });
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(true);
    expect(res.body.entry?.id).toBeTruthy();
    expect(res.body.entry.shiftId).toBe(shiftId);
    expect(res.body.entry.siteId).toBe(siteId);

    const [entry] = await db
      .select({
        clockInLat: timeEntriesTable.clockInLat,
        clockInLng: timeEntriesTable.clockInLng,
        clockOutTime: timeEntriesTable.clockOutTime,
        notes: timeEntriesTable.notes,
      })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.entry.id));
    expect(Number(entry.clockInLat)).toBeCloseTo(SITE_LAT, 5);
    expect(Number(entry.clockInLng)).toBeCloseTo(SITE_LNG, 5);
    expect(entry.clockOutTime).toBeNull();
    expect(entry.notes).toMatch(/auto clocked in/i);

    const [shift] = await db
      .select({ status: shiftsTable.status })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId));
    expect(shift.status).toBe("active");

    await cleanupScenario(ctx.officerId, shiftId, siteId);
  });

  it("400s when lat/lng are missing or non-numeric", async () => {
    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({});
    expect(res.status).toBe(400);

    const res2 = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: "abc", lng: SITE_LNG });
    expect(res2.status).toBe(400);
  });
});
