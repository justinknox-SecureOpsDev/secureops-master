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
  licensesTable,
  incidentsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// All test rows are tagged so we can scope cleanup precisely. The tag is
// embedded in user emails / client names / shift titles so a parallel
// or aborted run can't trample real seed data.
const TAG = `dispatch-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  dispatcherId: string;
  employeeId: string;
  employee2Id: string;
  clientId: string;
  siteId: string;
  adminToken: string;
  dispatcherToken: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "dispatcher" | "employee"): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${role}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: role[0].toUpperCase() + role.slice(1),
      lastName: TAG,
      role,
      status: "active",
      // Set the watermark to the epoch so JWT iat (whole seconds,
      // floored) is never accidentally < tokensValidAfter (ms-precision
      // insert timestamp) within the same wall-clock second.
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin");
  ctx.dispatcherId = await makeUser("dispatcher");
  ctx.employeeId = await makeUser("employee");
  ctx.employee2Id = await makeUser("employee");

  // Qualifying license (level 3 covers required level 2+) so both
  // employees are eligible for assign-nearest.
  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  for (const empId of [ctx.employeeId, ctx.employee2Id]) {
    await db.insert(licensesTable).values({
      employeeId: empId,
      type: "tx-security",
      level: 3,
      licenseNumber: `${TAG}-${empId.slice(0, 6)}`,
      expiryDate: futureDate,
    });
  }

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "100 Test Way",
      locationLat: "30.000000",
      locationLng: "-97.000000",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // Give employees a recent location near the site so the haversine
  // sort is deterministic and they always rank as the top candidate.
  await db
    .update(usersTable)
    .set({
      lastLat: "30.001000",
      lastLng: "-97.001000",
      lastLocationAt: new Date(),
    })
    .where(sql`${usersTable.id} IN (${sql.raw(`'${ctx.employeeId}','${ctx.employee2Id}'`)})`);

  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
  ctx.dispatcherToken = signToken({
    userId: ctx.dispatcherId,
    email: `${TAG}-dispatcher@example.test`,
    role: "dispatcher",
  });
});

afterAll(async () => {
  // Cleanup. Order matters: child rows before parents. Most foreign
  // keys cascade on user delete, but shifts/sites/clients we delete
  // explicitly to keep the row count bounded.
  const ids = [ctx.adminId, ctx.dispatcherId, ctx.employeeId, ctx.employee2Id].filter(
    Boolean,
  );
  if (ids.length > 0) {
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})`,
    );
    await db.execute(
      sql`DELETE FROM incidents WHERE employee_id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})`,
    );
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Pool is closed by globalTeardown — leaving it open here so other
  // test files in the same vitest worker can keep using it.
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("dispatcher role authorization", () => {
  it("can read /dispatch endpoints", async () => {
    const endpoints = [
      "/api/dispatch/status-board",
      "/api/dispatch/open-shifts",
      "/api/dispatch/active-incidents",
      "/api/dispatch/broadcast-rooms",
    ];
    for (const url of endpoints) {
      const res = await request(app).get(url).set(authed(ctx.dispatcherToken));
      expect(res.status, `${url} should allow dispatcher`).toBe(200);
    }
  });

  it("can POST /shifts/:id/assignments", async () => {
    const start = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-assign-shift`,
        siteId: ctx.siteId,
        startTime: start,
        endTime: end,
        requiredLicenseLevel: 2,
        headcount: 2,
        status: "upcoming",
      })
      .returning({ id: shiftsTable.id });

    const res = await request(app)
      .post(`/api/shifts/${shift.id}/assignments`)
      .set(authed(ctx.dispatcherToken))
      .send({ employeeId: ctx.employeeId });
    expect(res.status).toBe(201);
    expect(res.body.shiftId).toBe(shift.id);
    expect(res.body.employeeId).toBe(ctx.employeeId);
  });

  it("is blocked from /payroll/*, /admin/audit-logs, /admin/system/status, /admin/users", async () => {
    const protectedEndpoints: Array<[string, string]> = [
      ["GET", "/api/payroll"],
      ["POST", "/api/payroll/generate"],
      ["POST", "/api/payroll/pay-run/preview"],
      ["GET", "/api/admin/audit-logs"],
      ["GET", "/api/admin/system/status"],
      ["GET", "/api/admin/users/invitations"],
      ["GET", "/api/admin/tables/users"],
    ];
    for (const [method, url] of protectedEndpoints) {
      const req = (request(app) as unknown as Record<string, (u: string) => request.Test>)[
        method.toLowerCase()
      ](url);
      const res = await req.set(authed(ctx.dispatcherToken)).send({});
      expect(res.status, `${method} ${url} should reject dispatcher`).toBe(403);
    }
  });
});

describe("dispatch status-board bucketing", () => {
  it("places accepted assignments into the right buckets", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const MIN = 60 * 1000;

    // scheduled: started a couple minutes ago (well within LATE_MIN=10) so
    // it is always inside the status-board's today / currently-running
    // window regardless of wall-clock time, yet not yet "late". A future
    // start (e.g. +4h) is flaky: run late in the day it crosses midnight
    // and falls outside the board's [startOfDay, endOfDay] window, so the
    // shift never appears in any bucket.
    const scheduledShift = await insertShift({
      title: `${TAG}-bucket-scheduled`,
      start: new Date(now - 2 * MIN),
      end: new Date(now + 8 * HOUR),
    });
    // late: started 20 min ago (>LATE_MIN=10), no clock-in
    const lateShift = await insertShift({
      title: `${TAG}-bucket-late`,
      start: new Date(now - 20 * MIN),
      end: new Date(now + 4 * HOUR),
    });
    // no-show: started 90 min ago (>NO_SHOW_MIN=60), no clock-in
    const noShowShift = await insertShift({
      title: `${TAG}-bucket-noshow`,
      start: new Date(now - 90 * MIN),
      end: new Date(now + 2 * HOUR),
    });
    // onDuty: started, officer clocked in (open time entry)
    const onDutyShift = await insertShift({
      title: `${TAG}-bucket-onduty`,
      start: new Date(now - 30 * MIN),
      end: new Date(now + 4 * HOUR),
    });
    // earlyOut: officer clocked in then out, scheduled end still >EARLY_OUT_MIN=30 away
    const earlyOutShift = await insertShift({
      title: `${TAG}-bucket-earlyout`,
      start: new Date(now - 2 * HOUR),
      end: new Date(now + 2 * HOUR),
    });

    const shifts = [scheduledShift, lateShift, noShowShift, onDutyShift, earlyOutShift];
    for (const s of shifts) {
      await db.insert(shiftAssignmentsTable).values({
        shiftId: s,
        employeeId: ctx.employeeId,
        status: "accepted",
      });
    }

    // onDuty: open time entry (no clock-out)
    await db.insert(timeEntriesTable).values({
      shiftId: onDutyShift,
      employeeId: ctx.employeeId,
      clockInTime: new Date(now - 25 * MIN),
    });
    // earlyOut: closed time entry, clocked out 5 min ago
    await db.insert(timeEntriesTable).values({
      shiftId: earlyOutShift,
      employeeId: ctx.employeeId,
      clockInTime: new Date(now - 2 * HOUR),
      clockOutTime: new Date(now - 5 * MIN),
    });

    const res = await request(app)
      .get("/api/dispatch/status-board")
      .set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, Array<{ shiftId: string }>>;

    const shiftIdIn = (bucket: string, id: string) =>
      (body[bucket] ?? []).some((r) => r.shiftId === id);

    expect(shiftIdIn("scheduled", scheduledShift), "scheduled bucket").toBe(true);
    expect(shiftIdIn("late", lateShift), "late bucket").toBe(true);
    expect(shiftIdIn("noShow", noShowShift), "noShow bucket").toBe(true);
    expect(shiftIdIn("onDuty", onDutyShift), "onDuty bucket").toBe(true);
    expect(shiftIdIn("earlyOut", earlyOutShift), "earlyOut bucket").toBe(true);

    // No double-bucketing for any of our seeded shifts.
    for (const sid of shifts) {
      const buckets = (["scheduled", "late", "noShow", "onDuty", "earlyOut"] as const).filter(
        (b) => shiftIdIn(b, sid),
      );
      expect(buckets.length, `shift ${sid} in exactly one bucket`).toBe(1);
    }
  });

  it("flags onDuty entries left open well past their shift or (shift-less) far too long as stuck", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    // Earlier tests in this file may have left an open entry for these
    // officers; clear it so this test's own open entries are unambiguous.
    await db.delete(timeEntriesTable).where(sql`
      ${timeEntriesTable.employeeId} IN (${ctx.employeeId}, ${ctx.employee2Id})
      AND ${timeEntriesTable.clockOutTime} IS NULL
    `);

    // Genuinely stuck: shift ended 5h ago (> STUCK_SHIFT_GRACE_HOURS=2), still open.
    const stuckShift = await insertShift({
      title: `${TAG}-stuck-shift`,
      start: new Date(now - 9 * HOUR),
      end: new Date(now - 5 * HOUR),
    });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: stuckShift, employeeId: ctx.employeeId, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: stuckShift, employeeId: ctx.employeeId, clockInTime: new Date(now - 9 * HOUR),
    });

    // Not (yet) stuck: shift ended 30 min ago, well within the grace window.
    const freshShift = await insertShift({
      title: `${TAG}-fresh-shift`,
      start: new Date(now - 4 * HOUR),
      end: new Date(now - 30 * 60 * 1000),
    });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: freshShift, employeeId: ctx.employee2Id, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: freshShift, employeeId: ctx.employee2Id, clockInTime: new Date(now - 4 * HOUR),
    });

    const res = await request(app)
      .get("/api/dispatch/status-board")
      .set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(200);
    const onDuty = res.body.onDuty as Array<{ shiftId: string; stuck: boolean; hoursOpen: number }>;

    const stuckRow = onDuty.find((r) => r.shiftId === stuckShift);
    expect(stuckRow?.stuck, "shift ended 5h ago is stuck").toBe(true);
    expect(stuckRow?.hoursOpen).toBeGreaterThanOrEqual(8.9);

    const freshRow = onDuty.find((r) => r.shiftId === freshShift);
    expect(freshRow?.stuck, "shift ended 30min ago is not yet stuck").toBe(false);
  });

  it("derives the stuck threshold from each site's own auto-clock-out policy, not a fixed grace window", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    const longDelayEmployee = await makeUser("employee");
    const disabledSiteEmployee = await makeUser("employee");

    // Site configured with a 4h auto-clock-out delay (well above the
    // default). An entry 3h past shift end is still WITHIN that site's own
    // policy window and must never be flagged stuck.
    const [longDelaySite] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-long-delay-site`,
        address: "200 Test Way",
        autoClockOutEnabled: true,
        autoClockOutDelayMinutes: 240,
      })
      .returning({ id: sitesTable.id });

    const longDelayShift = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-long-delay-shift`,
        siteId: longDelaySite.id,
        startTime: new Date(now - 7 * HOUR),
        endTime: new Date(now - 3 * HOUR),
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
      })
      .returning({ id: shiftsTable.id })
      .then((rows) => rows[0].id);
    await db.insert(shiftAssignmentsTable).values({
      shiftId: longDelayShift, employeeId: longDelayEmployee, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: longDelayShift, employeeId: longDelayEmployee, clockInTime: new Date(now - 7 * HOUR),
    });

    // Site with auto-clock-out DISABLED entirely: the background sweep never
    // touches it (see autoClockOutEnabled === false early-continue), so this
    // manual flag is the only backstop. 3h past shift end must NOT be
    // flagged (no policy deadline ever applied), but a genuinely
    // long-abandoned entry (past STUCK_DISABLED_SITE_HOURS) must still be.
    const [disabledSite] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-disabled-site`,
        address: "300 Test Way",
        autoClockOutEnabled: false,
      })
      .returning({ id: sitesTable.id });

    const disabledSiteShift = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-disabled-site-shift`,
        siteId: disabledSite.id,
        startTime: new Date(now - 20 * HOUR),
        endTime: new Date(now - 3 * HOUR),
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
      })
      .returning({ id: shiftsTable.id })
      .then((rows) => rows[0].id);
    await db.insert(shiftAssignmentsTable).values({
      shiftId: disabledSiteShift, employeeId: disabledSiteEmployee, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: disabledSiteShift, employeeId: disabledSiteEmployee, clockInTime: new Date(now - 20 * HOUR),
    });

    const res = await request(app)
      .get("/api/dispatch/status-board")
      .set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(200);
    const onDuty = res.body.onDuty as Array<{ shiftId: string; stuck: boolean }>;

    const longDelayRow = onDuty.find((r) => r.shiftId === longDelayShift);
    expect(
      longDelayRow?.stuck,
      "3h past shift end is still inside this site's own 4h auto-clock-out delay",
    ).toBe(false);

    const disabledRow = onDuty.find((r) => r.shiftId === disabledSiteShift);
    expect(
      disabledRow?.stuck,
      "auto-clock-out disabled site has no policy deadline, but 20h open exceeds the flat backstop",
    ).toBe(true);
  });

  it("resolves the policy site the same way autoClockOutEndedShifts does — the entry's own siteId wins over its shift's", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const mismatchEmployee = await makeUser("employee");

    // Shift's site: short delay. If the stuck flag wrongly preferred the
    // shift's site (instead of matching the sweep job's own
    // coalesce(entrySiteId, shiftSiteId) precedence), 3h past shift end
    // would already be well past this site's deadline and get flagged.
    const [shortDelaySite] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-mismatch-shift-site`,
        address: "400 Test Way",
        autoClockOutEnabled: true,
        autoClockOutDelayMinutes: 30,
      })
      .returning({ id: sitesTable.id });

    // Entry's own site (e.g. an ad-hoc clock-in recorded at a different site
    // than the shift it's linked to): long delay. The real sweep job would
    // resolve THIS site's policy, so the entry must still be within it.
    const [longDelaySite] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-mismatch-entry-site`,
        address: "500 Test Way",
        autoClockOutEnabled: true,
        autoClockOutDelayMinutes: 240,
      })
      .returning({ id: sitesTable.id });

    const mismatchShift = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-mismatch-shift`,
        siteId: shortDelaySite.id,
        startTime: new Date(now - 7 * HOUR),
        endTime: new Date(now - 3 * HOUR),
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
      })
      .returning({ id: shiftsTable.id })
      .then((rows) => rows[0].id);
    await db.insert(shiftAssignmentsTable).values({
      shiftId: mismatchShift, employeeId: mismatchEmployee, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: mismatchShift,
      employeeId: mismatchEmployee,
      siteId: longDelaySite.id,
      clockInTime: new Date(now - 7 * HOUR),
    });

    const res = await request(app)
      .get("/api/dispatch/status-board")
      .set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(200);
    const onDuty = res.body.onDuty as Array<{ shiftId: string; stuck: boolean }>;

    const mismatchRow = onDuty.find((r) => r.shiftId === mismatchShift);
    expect(
      mismatchRow?.stuck,
      "3h past shift end is within the ENTRY's own site's 4h delay, even though the shift's site has only a 30min delay",
    ).toBe(false);
  });

  it("never flags an entry with a fresh on-site geofence ping, matching the sweep job's own exclusion", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const MIN = 60 * 1000;

    const freshInsideEmployee = await makeUser("employee");
    const staleInsideEmployee = await makeUser("employee");

    // Well past the default policy deadline for both — timing alone would
    // flag these as stuck.
    const freshInsideShift = await insertShift({
      title: `${TAG}-fresh-inside-shift`,
      start: new Date(now - 9 * HOUR),
      end: new Date(now - 5 * HOUR),
    });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: freshInsideShift, employeeId: freshInsideEmployee, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: freshInsideShift,
      employeeId: freshInsideEmployee,
      clockInTime: new Date(now - 9 * HOUR),
      geofenceState: "inside",
    });
    // Fresh ping (well within GEOFENCE_FRESH_MS = 15min) — proof the officer
    // is demonstrably still on site right now.
    await db.update(usersTable)
      .set({ lastLat: "30.000000", lastLng: "-97.000000", lastLocationAt: new Date(now - 2 * MIN) })
      .where(sql`${usersTable.id} = ${freshInsideEmployee}`);

    const staleInsideShift = await insertShift({
      title: `${TAG}-stale-inside-shift`,
      start: new Date(now - 9 * HOUR),
      end: new Date(now - 5 * HOUR),
    });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: staleInsideShift, employeeId: staleInsideEmployee, status: "accepted",
    });
    await db.insert(timeEntriesTable).values({
      shiftId: staleInsideShift,
      employeeId: staleInsideEmployee,
      clockInTime: new Date(now - 9 * HOUR),
      geofenceState: "inside",
    });
    // "inside" but the location ping itself is stale (past GEOFENCE_FRESH_MS)
    // — not proof of anything right now, so the timing policy still governs
    // and this one MUST still be flagged.
    await db.update(usersTable)
      .set({ lastLat: "30.000000", lastLng: "-97.000000", lastLocationAt: new Date(now - 3 * HOUR) })
      .where(sql`${usersTable.id} = ${staleInsideEmployee}`);

    const res = await request(app)
      .get("/api/dispatch/status-board")
      .set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(200);
    const onDuty = res.body.onDuty as Array<{ shiftId: string; stuck: boolean }>;

    const freshRow = onDuty.find((r) => r.shiftId === freshInsideShift);
    expect(freshRow?.stuck, "fresh 'inside' ping is proof of life, never stuck").toBe(false);

    const staleRow = onDuty.find((r) => r.shiftId === staleInsideShift);
    expect(staleRow?.stuck, "stale 'inside' ping is not current proof, timing policy governs").toBe(true);
  });
});

describe("dispatch assign-nearest headcount race", () => {
  it("returns 409 when two concurrent calls compete for the only seat", async () => {
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-race-shift`,
        siteId: ctx.siteId,
        startTime: start,
        endTime: end,
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
      })
      .returning({ id: shiftsTable.id });

    const fire = () =>
      request(app)
        .post("/api/dispatch/assign-nearest")
        .set(authed(ctx.dispatcherToken))
        .send({ shiftId: shift.id });

    // True race: two concurrent calls hit a brand-new headcount=1 shift
    // with no existing assignments. There are two eligible candidates in
    // the pool, so both calls find a "top candidate" outside the tx; the
    // route's inner tx then takes `SELECT ... FOR UPDATE` on the shift,
    // re-checks filled<headcount, and either inserts (201) or aborts
    // (409). Exactly one must win.
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(
      statuses,
      `expected exactly one 201 and one 409 (got ${a.status},${b.status})`,
    ).toEqual([201, 409]);

    const conflictBody = a.status === 409 ? a.body : b.body;
    expect(conflictBody.error).toBe("Conflict");
    expect(conflictBody.message).toMatch(/full/i);

    // Headcount invariant: filled never exceeds shift.headcount, no
    // matter how the two concurrent transactions interleaved.
    const [{ filled }] = await db
      .select({ filled: sql<number>`count(*)::int` })
      .from(shiftAssignmentsTable)
      .where(
        sql`${shiftAssignmentsTable.shiftId} = ${shift.id}
            AND ${shiftAssignmentsTable.status} = 'accepted'`,
      );
    expect(filled, "no over-fill past headcount").toBe(1);
  });

  it("returns 409 when the shift is already full", async () => {
    // Non-race scenario kept for clarity: a follow-up call against an
    // already-full shift must 409 cleanly without inserting anything.
    // Window starts at now+14h (past every earlier test's assignment:
    // now+5h..+9h from the explicit-assign test and now+6h..+10h from the
    // race test). Otherwise, depending on which shared employee wins the
    // prior concurrent race, BOTH test employees can be `conflictingShift`
    // for an overlapping window, leaving assign-nearest with no eligible
    // candidate (200 instead of 201) — a ~50/50 flake.
    const start = new Date(Date.now() + 14 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-full-shift`,
        siteId: ctx.siteId,
        startTime: start,
        endTime: end,
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
      })
      .returning({ id: shiftsTable.id });

    const fire = () =>
      request(app)
        .post("/api/dispatch/assign-nearest")
        .set(authed(ctx.dispatcherToken))
        .send({ shiftId: shift.id });

    const first = await fire();
    expect(first.status, "first call fills the seat").toBe(201);

    const second = await fire();
    expect(second.status, "follow-up call on full shift is 409").toBe(409);
    expect(second.body.error).toBe("Conflict");
  });
});

async function insertShift(opts: { title: string; start: Date; end: Date }): Promise<string> {
  const [row] = await db
    .insert(shiftsTable)
    .values({
      title: opts.title,
      siteId: ctx.siteId,
      startTime: opts.start,
      endTime: opts.end,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  return row.id;
}
