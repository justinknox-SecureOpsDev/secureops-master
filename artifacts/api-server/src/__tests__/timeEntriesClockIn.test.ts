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
  adminToken: string;
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
  // Scrub orphan rows from any crashed previous run that share our TAG prefix.
  // Deleting users cascades their licenses, shift_assignments, and time_entries.
  // Shifts whose siteId references the orphan site are left in place (SET NULL FK)
  // but are harmless; we then delete the orphan site + client.
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'clockin-test-%'`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'clockin-test-%')`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE 'clockin-test-%'`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE 'clockin-test-%'`);

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

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@example.test`,
      passwordHash,
      firstName: "Admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.adminToken = signToken({
    userId: admin.id,
    email: `${TAG}-admin@example.test`,
    role: "admin",
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

  it("lets an unlicensed officer clock into an unarmed (level <= 2) shift they're assigned to", async () => {
    // Unlicensed / support staff have an effective eligibility level of 2, so
    // unarmed work is open to them. This is the bug being guarded against: they
    // were previously blocked from ALL clock-ins by a blanket licence gate.
    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.nearSiteId,
        title: `${TAG}-unarmed`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 1,
        requiredLicenseLevel: 2,
      })
      .returning({ id: shiftsTable.id });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: shift.id,
      employeeId: ctx.unlicensedEmployeeId,
      status: "accepted",
    });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.unlicensedToken))
      .send({ shiftId: shift.id });
    expect(res.status).toBe(201);

    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
  });

  it("blocks an unlicensed officer from clocking into an armed (level >= 3) shift (403 license_required)", async () => {
    // Armed (3) and L4/PPO (4) shifts still require the matching unexpired
    // licence even when the officer is rostered on them (an admin could have
    // manually assigned them). The clock-in eligibility gate must catch this.
    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.nearSiteId,
        title: `${TAG}-armed`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 1,
        requiredLicenseLevel: 3,
      })
      .returning({ id: shiftsTable.id });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: shift.id,
      employeeId: ctx.unlicensedEmployeeId,
      status: "accepted",
    });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.unlicensedToken))
      .send({ shiftId: shift.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("license_required");

    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
  });

  it("blocks a GPS (geo-resolved) clock-in for an unlicensed officer rostered on an armed shift (403 license_required)", async () => {
    // Same armed-shift block as the explicit-shiftId path, but exercised via the
    // GPS geo-resolution path: an admin-rostered, under-licensed officer who is
    // physically at the site must NOT clock into — and activate — their armed
    // assignment just because they sent coordinates instead of a shiftId.
    // (resolveOrAssignShiftForAdHocClockIn step 1.)
    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.nearSiteId,
        title: `${TAG}-geo-armed`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 1,
        requiredLicenseLevel: 3,
      })
      .returning({ id: shiftsTable.id });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: shift.id,
      employeeId: ctx.unlicensedEmployeeId,
      status: "accepted",
    });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.unlicensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("license_required");

    // The armed shift must NOT have been activated, and no time entry created.
    const [after] = await db
      .select({ status: shiftsTable.status })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shift.id));
    expect(after.status).toBe("upcoming");
    const open = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(and(eq(timeEntriesTable.employeeId, ctx.unlicensedEmployeeId), isNull(timeEntriesTable.clockOutTime)));
    expect(open).toHaveLength(0);

    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
  });

  it("clocks an unlicensed officer in WITHOUT attaching the billing-only fallback when the only matching shift is armed", async () => {
    // The officer is NOT rostered, so step 2 can't auto-assign them to the L3
    // shift (ineligible) and step 3's billing-only fallback would otherwise
    // attach — and activate — the armed shift. The fix skips that attach: the
    // officer still clocks in (site-only), but the entry is never bound to the
    // higher-level shift and the shift stays upcoming.
    // (resolveOrAssignShiftForAdHocClockIn step 3.)
    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId));
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.nearSiteId,
        title: `${TAG}-geo-armed-fallback`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 1,
        requiredLicenseLevel: 3,
      })
      .returning({ id: shiftsTable.id });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.unlicensedToken))
      .send({ lat: -54.123456, lng: -12.654321 });
    expect(res.status).toBe(201);

    // Time entry exists at the site but is NOT linked to the armed shift.
    const [entry] = await db
      .select({ shiftId: timeEntriesTable.shiftId, siteId: timeEntriesTable.siteId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.id));
    expect(entry.shiftId).toBeNull();
    expect(entry.siteId).toBe(ctx.nearSiteId);

    // ...the armed shift must stay upcoming (never activated)...
    const [after] = await db
      .select({ status: shiftsTable.status })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shift.id));
    expect(after.status).toBe("upcoming");

    // ...and no assignment was created for the unlicensed officer.
    const ours = await db
      .select({ id: shiftAssignmentsTable.id })
      .from(shiftAssignmentsTable)
      .where(and(
        eq(shiftAssignmentsTable.shiftId, shift.id),
        eq(shiftAssignmentsTable.employeeId, ctx.unlicensedEmployeeId),
      ));
    expect(ours).toHaveLength(0);

    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
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

describe("admin resolving an officer's time-correction request", () => {
  it("clears the correction flag/note when admin saves a timestamp correction (PATCH /times)", async () => {
    const clockIn = new Date(Date.now() - 3 * 3600_000);
    const [seeded] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.licensedEmployeeId,
        siteId: ctx.nearSiteId,
        clockInTime: clockIn,
        clockOutTime: new Date(Date.now() - 3600_000),
        correctionRequested: true,
        correctionNote: "Clock-in was 30 min late",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .patch(`/api/time-entries/${seeded.id}/times`)
      .set(authed(ctx.adminToken))
      .send({ clockInTime: new Date(Date.now() - 4 * 3600_000).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.correctionRequested).toBe(false);
    expect(res.body.correctionNote).toBeNull();

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, seeded.id));
  });

  it("clears the correction flag/note via POST /dismiss-correction without changing timestamps", async () => {
    const clockIn = new Date(Date.now() - 3 * 3600_000);
    const clockOut = new Date(Date.now() - 3600_000);
    const [seeded] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.licensedEmployeeId,
        siteId: ctx.nearSiteId,
        clockInTime: clockIn,
        clockOutTime: clockOut,
        correctionRequested: true,
        correctionNote: "Please double-check",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .post(`/api/time-entries/${seeded.id}/dismiss-correction`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.correctionRequested).toBe(false);
    expect(res.body.correctionNote).toBeNull();
    expect(new Date(res.body.clockInTime).getTime()).toBe(clockIn.getTime());
    expect(new Date(res.body.clockOutTime).getTime()).toBe(clockOut.getTime());

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, seeded.id));
  });

  it("rejects a non-admin calling POST /dismiss-correction", async () => {
    const [seeded] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.licensedEmployeeId,
        siteId: ctx.nearSiteId,
        clockInTime: new Date(Date.now() - 3600_000),
        correctionRequested: true,
        correctionNote: "officer note",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .post(`/api/time-entries/${seeded.id}/dismiss-correction`)
      .set(authed(ctx.licensedToken));
    expect(res.status).toBe(403);

    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, seeded.id));
  });

  it("returns 404 from POST /dismiss-correction for an unknown entry", async () => {
    const res = await request(app)
      .post(`/api/time-entries/${randomUUID()}/dismiss-correction`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(404);
  });
});

describe("POST /time-entries/clock-in by explicit siteId (GPS-less manual pick)", () => {
  async function makeNoCoordsSite(suffix: string): Promise<string> {
    // No locationLat/locationLng — mirrors the production sites that broke geo
    // clock-in and forced officers onto the manual-picker path.
    const [site] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-nocoords-${suffix}`,
        address: "2 No Coords Rd",
      })
      .returning({ id: sitesTable.id });
    return site.id;
  }

  async function makeShiftWithAssignment(siteId: string, employeeId: string): Promise<string> {
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId,
        title: `${TAG}-pick-shift`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 2,
        requiredLicenseLevel: 2,
      })
      .returning({ id: shiftsTable.id });
    await db.insert(shiftAssignmentsTable).values({ shiftId: shift.id, employeeId, status: "accepted" });
    return shift.id;
  }

  it("allows clock-in to a no-coords site the officer is rostered at and links to their own shift", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    const siteId = await makeNoCoordsSite("allowed");
    const shiftId = await makeShiftWithAssignment(siteId, ctx.licensedEmployeeId);

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ siteId });
    expect(res.status).toBe(201);

    const [entry] = await db
      .select({ siteId: timeEntriesTable.siteId, shiftId: timeEntriesTable.shiftId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.id));
    expect(entry.siteId).toBe(siteId);
    expect(entry.shiftId).toBe(shiftId);

    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.shiftId, shiftId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shiftId));
    await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  });

  it("rejects clock-in (403 not_rostered_here) to a site the officer is NOT rostered at", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    const siteId = await makeNoCoordsSite("forbidden");

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ siteId });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("not_rostered_here");

    // No time entry should have been created.
    const open = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(and(eq(timeEntriesTable.employeeId, ctx.licensedEmployeeId), isNull(timeEntriesTable.clockOutTime)));
    expect(open).toHaveLength(0);

    await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  });

  it("never auto-assigns the GPS-less picked-site path to an open shift the officer isn't on", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    const siteId = await makeNoCoordsSite("noautoassign");
    // The officer's own accepted shift at the site...
    const ownShiftId = await makeShiftWithAssignment(siteId, ctx.licensedEmployeeId);
    // ...plus a SEPARATE open shift at the same site the officer is NOT on.
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [openShift] = await db
      .insert(shiftsTable)
      .values({
        siteId,
        title: `${TAG}-open-shift`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 2,
        requiredLicenseLevel: 2,
      })
      .returning({ id: shiftsTable.id });

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ siteId });
    expect(res.status).toBe(201);

    // Attached to their OWN shift, not the open one.
    const [entry] = await db
      .select({ shiftId: timeEntriesTable.shiftId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.id));
    expect(entry.shiftId).toBe(ownShiftId);

    // No assignment was created on the open shift — the GPS-less path must not
    // self-assign the officer to slots they didn't already hold.
    const openAssignments = await db
      .select({ id: shiftAssignmentsTable.id })
      .from(shiftAssignmentsTable)
      .where(and(
        eq(shiftAssignmentsTable.shiftId, openShift.id),
        eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId),
      ));
    expect(openAssignments).toHaveLength(0);

    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, ownShiftId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, openShift.id));
    await db.delete(sitesTable).where(eq(sitesTable.id, siteId));
  });
});

describe("GET /me/clock-in-sites picker visibility", () => {
  it("returns only the sites the officer is rostered at", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.employeeId, ctx.licensedEmployeeId));

    const [rosteredSite] = await db
      .insert(sitesTable)
      .values({ clientId: ctx.clientId, name: `${TAG}-picker-rostered`, address: "3 Rostered Rd" })
      .returning({ id: sitesTable.id });
    const [otherSite] = await db
      .insert(sitesTable)
      .values({ clientId: ctx.clientId, name: `${TAG}-picker-other`, address: "4 Other Rd" })
      .returning({ id: sitesTable.id });
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: rosteredSite.id,
        title: `${TAG}-picker-shift`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 2,
        requiredLicenseLevel: 2,
      })
      .returning({ id: shiftsTable.id });
    await db.insert(shiftAssignmentsTable).values({ shiftId: shift.id, employeeId: ctx.licensedEmployeeId, status: "accepted" });

    const res = await request(app).get("/api/me/clock-in-sites").set(authed(ctx.licensedToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(rosteredSite.id);
    expect(ids).not.toContain(otherSite.id);

    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.shiftId, shift.id));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
    await db.delete(sitesTable).where(eq(sitesTable.id, rosteredSite.id));
    await db.delete(sitesTable).where(eq(sitesTable.id, otherSite.id));
  });
});
