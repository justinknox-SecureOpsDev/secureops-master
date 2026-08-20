/**
 * Database-level "one open time entry per officer" safety net.
 *
 * Every clock-in path already guards the invariant in application code (row
 * lock on the officer's `users` row + re-check before insert). The partial
 * unique index `time_entries_one_open_per_employee_uniq` is the backstop for a
 * future path that forgets that guard. These tests cover:
 *
 *   1. the index actually exists and rejects a second open row (23505),
 *   2. `isOpenTimeEntryConflict` recognises the real driver error and does NOT
 *      swallow an unrelated unique violation on the same table,
 *   3. each clock-in path turns that 23505 into its established
 *      "already clocked in" response instead of a 500.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and, isNull } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  timeEntriesTable,
  shiftsTable,
  shiftAssignmentsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { isOpenTimeEntryConflict, ONE_OPEN_TIME_ENTRY_INDEX } from "../lib/timeEntryConflict";
import { processInboundClockEvent } from "../routes/schedulerWebhook";

const TAG = `openuniq-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Remote South Atlantic coords, distinct from the other clock-in suites'
// fixtures so geo resolution can only match this suite's site.
const SITE_LAT = -56.778899;
const SITE_LNG = -13.445566;

type Ctx = {
  officerId: string;
  officerToken: string;
  adminToken: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function openEntries(employeeId: string) {
  return db
    .select({ id: timeEntriesTable.id })
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, employeeId), isNull(timeEntriesTable.clockOutTime)));
}

async function deleteEntries(employeeId: string) {
  await db.delete(timeEntriesTable).where(eq(timeEntriesTable.employeeId, employeeId));
}

/** The exact error Postgres raises for a second open entry. */
async function captureDuplicateOpenEntryError(): Promise<unknown> {
  await deleteEntries(ctx.officerId);
  await db.insert(timeEntriesTable).values({
    employeeId: ctx.officerId,
    siteId: ctx.siteId,
    clockInTime: new Date(),
    approvalStatus: "pending",
    isVerified: false,
  });
  let captured: unknown = null;
  try {
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId: ctx.siteId,
      clockInTime: new Date(),
      approvalStatus: "pending",
      isVerified: false,
    });
  } catch (err) {
    captured = err;
  }
  await deleteEntries(ctx.officerId);
  return captured;
}

beforeAll(async () => {
  const [officer] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-officer@example.test`,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.officerId = officer.id;
  ctx.officerToken = signToken({
    userId: officer.id,
    email: `${TAG}-officer@example.test`,
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
      address: "1 Backstop Way",
      locationLat: String(SITE_LAT),
      locationLng: String(SITE_LNG),
      autoClockInEnabled: true,
      geofenceRadiusMiles: "5",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteEntries(ctx.officerId);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("time_entries one-open-entry-per-officer index", () => {
  it("exists as a partial unique index on employee_id where clock_out_time is null", async () => {
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'time_entries' AND indexname = ${ONE_OPEN_TIME_ENTRY_INDEX}
    `);
    const def = (res as unknown as { rows: Array<{ indexdef: string }> }).rows[0]?.indexdef ?? "";
    expect(def).toMatch(/CREATE UNIQUE INDEX/i);
    expect(def).toMatch(/\(employee_id\)/);
    expect(def).toMatch(/WHERE \(clock_out_time IS NULL\)/i);
  });

  it("rejects a second open entry for the same officer with a 23505 the helper recognises", async () => {
    const err = await captureDuplicateOpenEntryError();
    expect(err).toBeTruthy();
    // Drizzle wraps the driver error, so the pg code/constraint live on `cause`.
    const pgErr = (err as { code?: string; cause?: { code?: string; constraint?: string } }).code
      ? (err as { code?: string; constraint?: string })
      : (err as { cause?: { code?: string; constraint?: string } }).cause!;
    expect(pgErr.code).toBe("23505");
    expect(pgErr.constraint).toBe(ONE_OPEN_TIME_ENTRY_INDEX);
    expect(isOpenTimeEntryConflict(err)).toBe(true);
  });

  it("still allows many CLOSED entries for the same officer", async () => {
    const base = Date.now() - 48 * 3600_000;
    for (let i = 0; i < 3; i++) {
      await db.insert(timeEntriesTable).values({
        employeeId: ctx.officerId,
        siteId: ctx.siteId,
        clockInTime: new Date(base + i * 3600_000),
        clockOutTime: new Date(base + i * 3600_000 + 1800_000),
        approvalStatus: "pending",
        isVerified: false,
      });
    }
    const rows = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.employeeId, ctx.officerId));
    expect(rows).toHaveLength(3);
  });

  it("does not classify an unrelated unique violation as an already-clocked-in conflict", () => {
    const other = Object.assign(new Error("duplicate key value violates unique constraint \"time_entries_external_uniq\""), {
      code: "23505",
      constraint: "time_entries_external_uniq",
    });
    expect(isOpenTimeEntryConflict(other)).toBe(false);
    expect(isOpenTimeEntryConflict(new Error("boom"))).toBe(false);
    expect(isOpenTimeEntryConflict(null)).toBe(false);
  });
});

describe("clock-in paths translate the database conflict", () => {
  it("manual clock-in answers 400 'Already clocked in' instead of a 500", async () => {
    const dbErr = await captureDuplicateOpenEntryError();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(dbErr as Error);

    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: SITE_LAT, lng: SITE_LNG });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Already clocked in");
  });

  it("auto clock-in answers triggered:false / already_clocked_in instead of a 500", async () => {
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 6 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.siteId,
        title: `${TAG}-auto-shift`,
        startTime: start,
        endTime: end,
        status: "upcoming",
        headcount: 1,
        requiredLicenseLevel: 1,
      })
      .returning({ id: shiftsTable.id });
    await db.insert(shiftAssignmentsTable).values({
      shiftId: shift.id,
      employeeId: ctx.officerId,
      status: "accepted",
    });

    const dbErr = await captureDuplicateOpenEntryError();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(dbErr as Error);

    const res = await request(app)
      .post("/api/time-entries/auto-clock-in")
      .set(authed(ctx.officerToken))
      .send({ lat: SITE_LAT, lng: SITE_LNG });

    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(false);
    expect(res.body.reason).toBe("already_clocked_in");

    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.shiftId, shift.id));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
  });

  it("dispatch on-behalf clock-in answers 409 'already clocked in' instead of a 500", async () => {
    const dbErr = await captureDuplicateOpenEntryError();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(dbErr as Error);

    const res = await request(app)
      .post(`/api/dispatch/officers/${ctx.officerId}/clock-in`)
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.siteId });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already clocked in/i);
  });

  it("scheduler inbound clock event skips rather than throwing when the officer is already clocked in", async () => {
    // Local open entry, far outside the scheduler dedup window (±5 min) and at
    // no site, so the inbound event falls through to the INSERT and hits the
    // index rather than merging.
    await deleteEntries(ctx.officerId);
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      clockInTime: new Date(Date.now() - 6 * 3600_000),
      approvalStatus: "pending",
      isVerified: false,
    });

    const result = await processInboundClockEvent({
      id: `${TAG}-evt-1`,
      employeeEmail: `${TAG}-officer@example.test`,
      clockInTime: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(result.action).toBe("skipped");
    expect(result.skipReason).toMatch(/already/i);
    expect(await openEntries(ctx.officerId)).toHaveLength(1);
  });
});
