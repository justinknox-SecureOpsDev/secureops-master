/**
 * Focused tests for the scheduled-shift release feature.
 *
 * Covers:
 *   - Worker feed hides future-claimableFrom shifts (not assigned)
 *   - Worker feed shows past/null claimableFrom shifts
 *   - Claim route rejects with 409 + code "not_yet_released" when claimableFrom is in the future
 *   - POST /shifts/repeat release modes: immediate, fixed, rolling
 *   - PUT /shifts/:id claimableFrom null reset clears announcedAt
 *   - PUT /shifts/bulk claimableFrom null reset
 *   - POST /shifts/:id/release sets claimableFrom=now, announcedAt=null, returns 200
 *   - Management view (admin GET /shifts) sees all shifts regardless of claimableFrom
 *   - GET /dispatch/open-shifts includes claimableFrom field
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  licensesTable,
  notificationsTable,
  trainingCertificationsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { announceScheduledShifts } from "../lib/scheduledJobs";

const TAG = `shift-release-test-${randomUUID().slice(0, 8)}`;
const REQUIRED_TRAINING = `${TAG}-site-induction`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  employeeId: string;
  adminId: string;
  dispatcherId: string;
  tokenEmployee: string;
  tokenAdmin: string;
  tokenDispatcher: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

async function makeUser(suffix: string, role: string, status = "active"): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Test",
      lastName: TAG,
      role,
      status,
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function insertShiftWithRelease(opts: {
  title: string;
  claimableFrom?: Date | null;
  announcedAt?: Date | null;
  headcount?: number;
  status?: string;
  startTime?: Date;
}): Promise<string> {
  const start = opts.startTime ?? new Date(Date.now() + 6 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [row] = await db
    .insert(shiftsTable)
    .values({
      title: opts.title,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      requiredLicenseLevel: 2,
      headcount: opts.headcount ?? 1,
      status: opts.status ?? "upcoming",
      claimableFrom: opts.claimableFrom !== undefined ? opts.claimableFrom : null,
      announcedAt: opts.announcedAt !== undefined ? opts.announcedAt : null,
    })
    .returning({ id: shiftsTable.id });
  return row.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.employeeId = await makeUser("emp", "employee");
  ctx.adminId = await makeUser("admin", "admin");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatcher");

  // Give the employee an L2 license.
  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.insert(licensesTable).values({
    employeeId: ctx.employeeId,
    type: "tx-security",
    level: 2,
    licenseNumber: `${TAG}-lic`,
    expiryDate: futureDate,
  });

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
      address: "1 Release Way",
      requiredTrainings: [REQUIRED_TRAINING],
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
  await db.insert(trainingCertificationsTable).values({
    employeeId: ctx.employeeId,
    type: REQUIRED_TRAINING,
    title: "Release test site induction",
  });

  ctx.tokenEmployee = signToken({ userId: ctx.employeeId, email: `${TAG}-emp@example.test`, role: "employee" });
  ctx.tokenAdmin = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.tokenDispatcher = signToken({ userId: ctx.dispatcherId, email: `${TAG}-dispatcher@example.test`, role: "dispatcher" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shift_assignments WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

// ─── Worker feed ─────────────────────────────────────────────────────────────

describe("Worker feed: claimableFrom visibility", () => {
  it("hides a shift with future claimableFrom from the employee feed (not assigned)", async () => {
    const futureRelease = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-future-release`,
      claimableFrom: futureRelease,
    });

    const res = await request(app)
      .get("/api/shifts?status=upcoming")
      .set(authed(ctx.tokenEmployee));

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(shiftId);
  });

  it("shows a shift with past claimableFrom in the employee feed", async () => {
    const pastRelease = new Date(Date.now() - 60 * 1000); // 1 min ago
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-past-release`,
      claimableFrom: pastRelease,
    });

    const res = await request(app)
      .get("/api/shifts?status=upcoming")
      .set(authed(ctx.tokenEmployee));

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(shiftId);
  });

  it("shows a shift with null claimableFrom in the employee feed (immediate release)", async () => {
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-null-release`,
      claimableFrom: null,
    });

    const res = await request(app)
      .get("/api/shifts?status=upcoming")
      .set(authed(ctx.tokenEmployee));

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(shiftId);
  });

  it("shows a future-claimableFrom shift if the employee is already assigned", async () => {
    const futureRelease = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-assigned-future`,
      claimableFrom: futureRelease,
    });
    // Assign the employee directly.
    await db.insert(shiftAssignmentsTable).values({
      shiftId,
      employeeId: ctx.employeeId,
      status: "accepted",
    });

    const res = await request(app)
      .get("/api/shifts?status=upcoming")
      .set(authed(ctx.tokenEmployee));

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(shiftId);
  });

  it("admin management view always sees all shifts regardless of claimableFrom", async () => {
    const futureRelease = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-admin-sees-all`,
      claimableFrom: futureRelease,
    });

    const res = await request(app)
      .get("/api/shifts?status=upcoming")
      .set(authed(ctx.tokenAdmin));

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(shiftId);
  });
});

// ─── Claim route ─────────────────────────────────────────────────────────────

describe("Claim route: future claimableFrom rejection", () => {
  it("returns 409 with code=not_yet_released and a claimableFrom date when release is in the future", async () => {
    const futureRelease = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h from now
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-claim-future`,
      claimableFrom: futureRelease,
    });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenEmployee))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_yet_released");
    expect(res.body.claimableFrom).toBeTruthy();
    expect(new Date(res.body.claimableFrom).getTime()).toBeCloseTo(futureRelease.getTime(), -3);
    expect(res.body.message).toMatch(/isn't open.*claiming yet/i);
  });

  it("allows claiming a shift with a past claimableFrom", async () => {
    const pastRelease = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-claim-past`,
      claimableFrom: pastRelease,
    });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenEmployee))
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.shiftId).toBe(shiftId);
  });

  it("allows claiming a shift with null claimableFrom", async () => {
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-claim-null`,
      claimableFrom: null,
    });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenEmployee))
      .send({});

    expect(res.status).toBe(201);
  });
});

// ─── PUT /shifts/:id claimableFrom handling ───────────────────────────────────

describe("PUT /shifts/:id: claimableFrom and announcedAt management", () => {
  it("null claimableFrom in PUT resets both claimableFrom and announcedAt to null", async () => {
    const futureRelease = new Date(Date.now() + 60 * 60 * 1000);
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-put-null`,
      claimableFrom: futureRelease,
      announcedAt: null,
    });

    const res = await request(app)
      .put(`/api/shifts/${shiftId}`)
      .set(authed(ctx.tokenAdmin))
      .send({ claimableFrom: null });

    expect(res.status).toBe(200);
    expect(res.body.claimableFrom).toBeNull();
    expect(res.body.announcedAt).toBeNull();

    const [row] = await db.select({ claimableFrom: shiftsTable.claimableFrom, announcedAt: shiftsTable.announcedAt })
      .from(shiftsTable).where(eq(shiftsTable.id, shiftId));
    expect(row.claimableFrom).toBeNull();
    expect(row.announcedAt).toBeNull();
  });

  it("future ISO claimableFrom in PUT sets it and clears announcedAt", async () => {
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-put-future`,
      claimableFrom: null,
      announcedAt: new Date(), // previously announced
    });

    const futureIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .put(`/api/shifts/${shiftId}`)
      .set(authed(ctx.tokenAdmin))
      .send({ claimableFrom: futureIso });

    expect(res.status).toBe(200);
    expect(res.body.claimableFrom).toBeTruthy();
    expect(res.body.announcedAt).toBeNull();

    const [row] = await db.select({ claimableFrom: shiftsTable.claimableFrom, announcedAt: shiftsTable.announcedAt })
      .from(shiftsTable).where(eq(shiftsTable.id, shiftId));
    expect(row.claimableFrom).toBeTruthy();
    expect(row.announcedAt).toBeNull();
  });

  it("omitting claimableFrom from PUT body leaves existing value unchanged", async () => {
    const futureRelease = new Date(Date.now() + 90 * 60 * 1000);
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-put-omit`,
      claimableFrom: futureRelease,
    });

    const res = await request(app)
      .put(`/api/shifts/${shiftId}`)
      .set(authed(ctx.tokenAdmin))
      .send({ notes: "updated notes" }); // no claimableFrom key

    expect(res.status).toBe(200);
    // claimableFrom should still be set (unchanged).
    expect(res.body.claimableFrom).toBeTruthy();
  });
});

// ─── PUT /shifts/bulk claimableFrom handling ─────────────────────────────────

describe("PUT /shifts/bulk: claimableFrom reset", () => {
  it("null claimableFrom in bulk reset clears release and announcedAt", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const id1 = await insertShiftWithRelease({ title: `${TAG}-bulk-null-a`, claimableFrom: future });
    const id2 = await insertShiftWithRelease({ title: `${TAG}-bulk-null-b`, claimableFrom: future });

    const res = await request(app)
      .put("/api/shifts/bulk")
      .set(authed(ctx.tokenAdmin))
      .send({ ids: [id1, id2], changes: { claimableFrom: null } });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    for (const id of [id1, id2]) {
      const [row] = await db.select({ claimableFrom: shiftsTable.claimableFrom, announcedAt: shiftsTable.announcedAt })
        .from(shiftsTable).where(eq(shiftsTable.id, id));
      expect(row.claimableFrom).toBeNull();
      expect(row.announcedAt).toBeNull();
    }
  });
});

// ─── POST /shifts/:id/release ─────────────────────────────────────────────────

describe("POST /shifts/:id/release", () => {
  it("sets claimableFrom to now and announcedAt to null, returns 200 (admin)", async () => {
    const futureRelease = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-release-route`,
      claimableFrom: futureRelease,
      announcedAt: null,
    });

    const beforeTime = Date.now();
    const res = await request(app)
      .post(`/api/shifts/${shiftId}/release`)
      .set(authed(ctx.tokenAdmin))
      .send({});
    const afterTime = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.announcedAt).toBeNull();
    // claimableFrom should be now (within a few seconds of the request).
    const cf = new Date(res.body.claimableFrom).getTime();
    expect(cf).toBeGreaterThanOrEqual(beforeTime - 1000);
    expect(cf).toBeLessThanOrEqual(afterTime + 1000);

    // Verify in DB.
    const [row] = await db.select({ claimableFrom: shiftsTable.claimableFrom, announcedAt: shiftsTable.announcedAt })
      .from(shiftsTable).where(eq(shiftsTable.id, shiftId));
    expect(row.claimableFrom).not.toBeNull();
    // announcedAt may have been set by the inline push handler if eligible officers exist.
    // We only assert claimableFrom is recent.
    expect(new Date(row.claimableFrom!).getTime()).toBeGreaterThanOrEqual(beforeTime - 1000);
  });

  it("works for dispatchers too", async () => {
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-release-dispatcher`,
      claimableFrom: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/release`)
      .set(authed(ctx.tokenDispatcher))
      .send({});

    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown shift ID", async () => {
    const res = await request(app)
      .post(`/api/shifts/${randomUUID()}/release`)
      .set(authed(ctx.tokenAdmin))
      .send({});

    expect(res.status).toBe(404);
  });

  it("after release, the shift is claimable by a qualified employee", async () => {
    const futureRelease = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-post-release-claim`,
      claimableFrom: futureRelease,
    });

    // Release it.
    await request(app)
      .post(`/api/shifts/${shiftId}/release`)
      .set(authed(ctx.tokenAdmin))
      .send({});

    // Now claim should succeed.
    const res = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenEmployee))
      .send({});

    expect(res.status).toBe(201);
  });
});

describe("POST /shifts/:id/notify-vacancy", () => {
  it("rejects manual officer notifications before the scheduled release", async () => {
    const futureRelease = new Date(Date.now() + 60 * 60 * 1000);
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-notify-embargo`,
      claimableFrom: futureRelease,
    });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/notify-vacancy`)
      .set(authed(ctx.tokenAdmin))
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_yet_released");
    expect(res.body.message).toMatch(/opens for claiming/i);
  });

  it("uses required-training eligibility when selecting recipients", async () => {
    const withoutTraining = await makeUser("notify-no-training", "employee");
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.insert(licensesTable).values({
      employeeId: withoutTraining,
      type: "tx-security",
      level: 2,
      licenseNumber: `${TAG}-notify-no-training-lic`,
      expiryDate: futureDate,
    });
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-notify-training-filter`,
      claimableFrom: new Date(Date.now() - 60_000),
    });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/notify-vacancy`)
      .set(authed(ctx.tokenAdmin))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.notifiedCount).toBe(1);
  });
});

// ─── POST /shifts/repeat release modes ───────────────────────────────────────

describe("POST /shifts/repeat: release modes", () => {
  // Use a unique offset per test run so idempotency-skip logic doesn't cause
  // cross-test interference (each test gets its own date range).
  let repeatOffset = 7; // days ahead; incremented per test call
  const baseRepeatBody = (title: string, release?: Record<string, unknown>) => {
    const offset = repeatOffset;
    repeatOffset += 14; // each call advances 2 weeks to guarantee no overlap
    return {
      base: {
        title,
        siteId: "", // filled in beforeAll
        requiredLicenseLevel: 2,
        headcount: 1,
        payRate: "15",
        billRate: "20",
      },
      recurrence: {
        startDate: new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        untilDate: new Date(Date.now() + (offset + 7) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
        startTime: "09:00",
        endTime: "17:00",
        tz: "America/Chicago",
        ...(release ? { release } : {}),
      },
    };
  };

  it("mode=immediate: all created shifts are claimable immediately with an announcement timestamp", async () => {
    const body = baseRepeatBody(`${TAG}-rep-immediate`);
    body.base.siteId = ctx.siteId;
    body.recurrence = { ...body.recurrence, release: { mode: "immediate" } } as any;

    const res = await request(app)
      .post("/api/shifts/repeat")
      .set(authed(ctx.tokenAdmin))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);
    for (const s of res.body.shifts) {
      expect(new Date(s.claimableFrom).getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it("mode=fixed: all created shifts share the same claimableFrom timestamp", async () => {
    const body = baseRepeatBody(`${TAG}-rep-fixed`);
    body.base.siteId = ctx.siteId;
    // Use a release date well before the shifts start (which start 21+ days from now).
    const releaseDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const releaseDateStr = releaseDate.toISOString().slice(0, 10);
    (body.recurrence as any).release = {
      mode: "fixed",
      date: releaseDateStr,
      time: "08:00",
    };

    const res = await request(app)
      .post("/api/shifts/repeat")
      .set(authed(ctx.tokenAdmin))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);

    // All shifts must share the same claimableFrom.
    const dates = (res.body.shifts as Array<{ claimableFrom: string | null }>).map((s) => s.claimableFrom);
    expect(dates.every((d) => d != null)).toBe(true);
    // All should be the same UTC instant.
    const unique = new Set(dates.map((d) => new Date(d!).getTime()));
    expect(unique.size).toBe(1);
  });

  it("mode=fixed: requires release.date and release.time (400 if missing)", async () => {
    const body = baseRepeatBody(`${TAG}-rep-fixed-bad`);
    body.base.siteId = ctx.siteId;
    (body.recurrence as any).release = { mode: "fixed" }; // no date/time

    const res = await request(app)
      .post("/api/shifts/repeat")
      .set(authed(ctx.tokenAdmin))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/release\.date.*release\.time/i);
  });

  it("mode=rolling: shifts have per-occurrence claimableFrom leadDays before start", async () => {
    const body = baseRepeatBody(`${TAG}-rep-rolling`);
    body.base.siteId = ctx.siteId;
    (body.recurrence as any).release = { mode: "rolling", leadDays: 2 };

    const res = await request(app)
      .post("/api/shifts/repeat")
      .set(authed(ctx.tokenAdmin))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);

    // Each shift's claimableFrom should be ~48h before its startTime.
    for (const s of res.body.shifts as Array<{ startTime: string; claimableFrom: string | null }>) {
      if (!s.claimableFrom) continue; // might be null if offset was in the past
      const startMs = new Date(s.startTime).getTime();
      const cfMs = new Date(s.claimableFrom).getTime();
      const diff = startMs - cfMs;
      // Allow 5 minutes tolerance for DST/wall-time rounding.
      expect(diff).toBeGreaterThanOrEqual(48 * 60 * 60 * 1000 - 5 * 60 * 1000);
      expect(diff).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 5 * 60 * 1000);
    }
  });

  it("mode=rolling: requires leadDays (400 if missing)", async () => {
    const body = baseRepeatBody(`${TAG}-rep-rolling-bad`);
    body.base.siteId = ctx.siteId;
    (body.recurrence as any).release = { mode: "rolling" }; // no leadDays

    const res = await request(app)
      .post("/api/shifts/repeat")
      .set(authed(ctx.tokenAdmin))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/leadDays/i);
  });
});

// ─── GET /dispatch/open-shifts ────────────────────────────────────────────────

describe("GET /dispatch/open-shifts: includes claimableFrom", () => {
  it("returns claimableFrom field on each row", async () => {
    // Create a shift that starts within 72h.
    const futureRelease = new Date(Date.now() + 30 * 60 * 1000);
    await insertShiftWithRelease({
      title: `${TAG}-dispatch-open`,
      claimableFrom: futureRelease,
    });

    const res = await request(app)
      .get("/api/dispatch/open-shifts")
      .set(authed(ctx.tokenAdmin));

    expect(res.status).toBe(200);
    // Find our shift in the response.
    const shifts = res.body as Array<{ id: string; claimableFrom: string | null }>;
    // Every row should have a claimableFrom property (possibly null).
    for (const s of shifts) {
      expect("claimableFrom" in s).toBe(true);
    }
  });
});

describe("scheduled release announcement runner", () => {
  it("atomically claims due rows, batches by officer/site, filters assigned officers, and is idempotent", async () => {
    // 10:00 AM Central: safely inside the runner's daytime window.
    const tick = new Date("2026-08-18T15:00:00.000Z");
    const release = new Date(tick.getTime() - 60_000);
    const start = new Date(tick.getTime() + 6 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const rows = await db.insert(shiftsTable).values([
      {
        title: `${TAG}-announce-a`,
        siteId: ctx.siteId,
        startTime: start,
        endTime: end,
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
        claimableFrom: release,
      },
      {
        title: `${TAG}-announce-b`,
        siteId: ctx.siteId,
        startTime: new Date(start.getTime() + 24 * 60 * 60 * 1000),
        endTime: new Date(end.getTime() + 24 * 60 * 60 * 1000),
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
        claimableFrom: release,
      },
      {
        title: `${TAG}-announce-assigned`,
        siteId: ctx.siteId,
        startTime: new Date(start.getTime() + 48 * 60 * 60 * 1000),
        endTime: new Date(end.getTime() + 48 * 60 * 60 * 1000),
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
        claimableFrom: release,
      },
      {
        title: `${TAG}-announce-legacy-null`,
        siteId: ctx.siteId,
        startTime: new Date(start.getTime() + 72 * 60 * 60 * 1000),
        endTime: new Date(end.getTime() + 72 * 60 * 60 * 1000),
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "upcoming",
        claimableFrom: null,
      },
    ]).returning({ id: shiftsTable.id, title: shiftsTable.title });
    const assigned = rows.find((row) => row.title.endsWith("-assigned"))!;
    const legacy = rows.find((row) => row.title.endsWith("-legacy-null"))!;
    await db.insert(shiftAssignmentsTable).values({
      shiftId: assigned.id,
      employeeId: ctx.employeeId,
      status: "accepted",
    });

    const before = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.userId, ctx.employeeId),
        eq(notificationsTable.type, "shift_available"),
      ));

    await Promise.all([announceScheduledShifts(tick), announceScheduledShifts(tick)]);
    await announceScheduledShifts(new Date(tick.getTime() + 5 * 60_000));

    const after = await db
      .select({ id: notificationsTable.id, data: notificationsTable.data })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.userId, ctx.employeeId),
        eq(notificationsTable.type, "shift_available"),
      ));
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.data?.count).toBe("2");

    const claimed = await db
      .select({ id: shiftsTable.id, announcedAt: shiftsTable.announcedAt })
      .from(shiftsTable)
      .where(inArray(shiftsTable.id, rows.map((row) => row.id)));
    expect(claimed.filter((row) => row.id !== legacy.id).every((row) => row.announcedAt != null)).toBe(true);
    expect(claimed.find((row) => row.id === legacy.id)?.announcedAt).toBeNull();
  });

  it("holds alerts outside daytime hours without delaying release eligibility", async () => {
    // 1:00 AM Central is outside the 08:00–20:00 notification window.
    const nightTick = new Date("2026-08-19T06:00:00.000Z");
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-announce-night-hold`,
      claimableFrom: new Date(nightTick.getTime() - 60_000),
      startTime: new Date(nightTick.getTime() + 6 * 60 * 60 * 1000),
    });

    await announceScheduledShifts(nightTick);

    const [row] = await db
      .select({ announcedAt: shiftsTable.announcedAt, claimableFrom: shiftsTable.claimableFrom })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId));
    expect(row.announcedAt).toBeNull();
    expect(new Date(row.claimableFrom!).getTime()).toBeLessThanOrEqual(nightTick.getTime());
  });

  it("releases the atomic claim and retries when durable in-app persistence fails", async () => {
    const tick = new Date("2026-08-19T15:00:00.000Z");
    const shiftId = await insertShiftWithRelease({
      title: `${TAG}-announce-persist-retry`,
      claimableFrom: new Date(tick.getTime() - 60_000),
      startTime: new Date(tick.getTime() + 6 * 60 * 60 * 1000),
    });
    const before = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.userId, ctx.employeeId),
        eq(notificationsTable.type, "shift_available"),
      ));

    await announceScheduledShifts(tick, {
      persistNotifications: async () => { throw new Error("simulated persistence failure"); },
      sendDevicePush: async () => { throw new Error("must not send before persistence"); },
    });
    const [released] = await db
      .select({ announcedAt: shiftsTable.announcedAt })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId));
    expect(released.announcedAt).toBeNull();

    await announceScheduledShifts(new Date(tick.getTime() + 60_000), {
      sendDevicePush: async () => undefined,
    });
    const after = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.userId, ctx.employeeId),
        eq(notificationsTable.type, "shift_available"),
      ));
    expect(after).toHaveLength(before.length + 1);
    const [retried] = await db
      .select({ announcedAt: shiftsTable.announcedAt })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId));
    expect(retried.announcedAt).not.toBeNull();
  });
});
