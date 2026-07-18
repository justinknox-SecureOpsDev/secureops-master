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
    const start = new Date(Date.now() + 8 * 60 * 60 * 1000);
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
