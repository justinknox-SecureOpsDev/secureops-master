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

const TAG = `clockin-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  licensedEmployeeId: string;
  unlicensedEmployeeId: string;
  licensedToken: string;
  unlicensedToken: string;
  clientId: string;
  // Site with coords inside the 1-mile resolve radius of (32.7767, -96.7970).
  nearSiteId: string;
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

beforeAll(async () => {
  ctx.licensedEmployeeId = await makeEmployee("lic");
  ctx.unlicensedEmployeeId = await makeEmployee("nolic");
  ctx.licensedToken = signToken({
    userId: ctx.licensedEmployeeId,
    email: `${TAG}-lic@example.test`,
    role: "employee",
  });
  ctx.unlicensedToken = signToken({
    userId: ctx.unlicensedEmployeeId,
    email: `${TAG}-nolic@example.test`,
    role: "employee",
  });

  // Only the "licensed" officer gets an unexpired license.
  const futureDate = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  await db.insert(licensesTable).values({
    employeeId: ctx.licensedEmployeeId,
    type: "tx-security",
    level: 3,
    licenseNumber: `${TAG}-LIC`,
    expiryDate: futureDate,
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  // Site at downtown Dallas coords. Test pings will be ~50 ft away
  // (same coords) so resolveNearestSite returns this site.
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-near-site`,
      address: "1 Near Way",
      // Remote coordinates in the South Atlantic far from any seed/real
      // site, so the geo-resolver can ONLY match this fixture's site.
      locationLat: "-54.123456",
      locationLng: "-12.654321",
    })
    .returning({ id: sitesTable.id });
  ctx.nearSiteId = site.id;
});

afterAll(async () => {
  const ids = [ctx.licensedEmployeeId, ctx.unlicensedEmployeeId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM licenses WHERE employee_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function deleteOpenEntries(employeeId: string) {
  await db
    .delete(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, employeeId), isNull(timeEntriesTable.clockOutTime)));
}

describe("POST /time-entries/clock-in geo-resolution", () => {
  it("resolves the nearest site when no shiftId is provided and the officer is within 1 mile", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 }); // same coords as the site
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    // The route should stamp time_entries.siteId with the resolved site
    // so /payroll and /invoices group the entry correctly even though
    // no shiftId was provided.
    const [row] = await db
      .select({ siteId: timeEntriesTable.siteId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.id));
    expect(row.siteId).toBe(ctx.nearSiteId);

    // Clean up so the next test's "already clocked in" guard doesn't trip.
    await deleteOpenEntries(ctx.licensedEmployeeId);
  });

  it("returns 422 'No Site Nearby' when the officer is outside the 1-mile radius of every site", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    // Pacific Ocean — guaranteed to be >1 mile from any of our sites.
    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: 0, lng: -160 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No Site Nearby/i);
    expect(res.body.message).toMatch(/not within/i);
  });

  it("blocks an employee with no unexpired license (403 license_expired)", async () => {
    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.unlicensedToken))
      .send({ lat: 32.7767, lng: -96.797 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("license_expired");
  });
});

describe("POST /time-entries/clock-in auto-assigns to an open shift at the site", () => {
  async function makeShiftAtNearSite(headcount: number): Promise<string> {
    // Window straddles "now" so it falls inside the ±60-min match grace.
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.nearSiteId,
        title: `${TAG}-shift`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount,
        requiredLicenseLevel: 2,
      })
      .returning({ id: shiftsTable.id });
    return shift.id;
  }

  it("self-assigns an unrostered officer to an open shift and links the time entry to it", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    const shiftId = await makeShiftAtNearSite(2);

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(res.status).toBe(201);

    // The time entry must be linked to the open shift...
    const [entry] = await db
      .select({ shiftId: timeEntriesTable.shiftId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.id));
    expect(entry.shiftId).toBe(shiftId);

    // ...and an accepted assignment must now exist (this is what makes the
    // officer show up on the Dispatch status board's "On duty" tab).
    const assignments = await db
      .select({ status: shiftAssignmentsTable.status })
      .from(shiftAssignmentsTable)
      .where(and(
        eq(shiftAssignmentsTable.shiftId, shiftId),
        eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId),
      ));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].status).toBe("accepted");

    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shiftId));
  });

  it("does NOT auto-assign an officer to an open shift requiring a higher licence level", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    // Officer holds an L3 licence; this open shift requires L4.
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.nearSiteId,
        title: `${TAG}-l4-shift`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 2,
        requiredLicenseLevel: 4,
      })
      .returning({ id: shiftsTable.id });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(res.status).toBe(201);

    // The officer still clocks in (ad-hoc) but must NOT be assigned to the
    // higher-level shift.
    const ours = await db
      .select({ id: shiftAssignmentsTable.id })
      .from(shiftAssignmentsTable)
      .where(and(
        eq(shiftAssignmentsTable.shiftId, shift.id),
        eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId),
      ));
    expect(ours).toHaveLength(0);

    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
  });

  it("does NOT create a duplicate assignment when the shift is full and the officer isn't already on it", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    const shiftId = await makeShiftAtNearSite(1);
    // Fill the single slot with a throwaway officer.
    const otherId = await makeEmployee("filler");
    await db.insert(shiftAssignmentsTable).values({ shiftId, employeeId: otherId, status: "accepted" });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(res.status).toBe(201);

    // Officer still clocks in (ad-hoc), but is NOT assigned to the full shift.
    const ours = await db
      .select({ id: shiftAssignmentsTable.id })
      .from(shiftAssignmentsTable)
      .where(and(
        eq(shiftAssignmentsTable.shiftId, shiftId),
        eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId),
      ));
    expect(ours).toHaveLength(0);

    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.shiftId, shiftId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shiftId));
  });
});

describe("POST /time-entries/clock-out time-correction request", () => {
  it("flags the entry and stores the note when the officer submits a correction on clock-out", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    const clockIn = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(clockIn.status).toBe(201);
    const entryId = clockIn.body.id as string;

    const res = await request(app)
      .post("/api/time-entries/clock-out")
      .set(authed(ctx.licensedToken))
      .send({ timeEntryId: entryId, lat: -54.123456, lng: -12.654321, correctionNote: "  I forgot to clock in at 8am  " });
    expect(res.status).toBe(200);
    expect(res.body.correctionRequested).toBe(true);
    expect(res.body.correctionNote).toBe("I forgot to clock in at 8am");

    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, entryId));
  });

  it("does NOT clear an existing correction flag/note when a later admin clock-out sends a whitespace-only note", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    // Seed an already-flagged, still-open entry directly.
    const [seeded] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.licensedEmployeeId,
        siteId: ctx.nearSiteId,
        clockInTime: new Date(Date.now() - 3600_000),
        correctionRequested: true,
        correctionNote: "Original officer request",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .post("/api/time-entries/clock-out")
      .set(authed(ctx.licensedToken))
      .send({ timeEntryId: seeded.id, lat: -54.123456, lng: -12.654321, correctionNote: "   " });
    expect(res.status).toBe(200);
    // Whitespace-only note must leave the prior flag + note intact.
    expect(res.body.correctionRequested).toBe(true);
    expect(res.body.correctionNote).toBe("Original officer request");

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, seeded.id));
  });

  it("does NOT flag the entry when no correction note is provided", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    const clockIn = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(clockIn.status).toBe(201);
    const entryId = clockIn.body.id as string;

    const res = await request(app)
      .post("/api/time-entries/clock-out")
      .set(authed(ctx.licensedToken))
      .send({ timeEntryId: entryId, lat: -54.123456, lng: -12.654321 });
    expect(res.status).toBe(200);
    expect(res.body.correctionRequested).toBe(false);

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, entryId));
  });
});
