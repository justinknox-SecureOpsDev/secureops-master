/**
 * GET /time-entries — role scoping + deterministic ordering.
 *
 * Regression cover for the "Confirm your last shift" card showing another
 * officer's shift to an admin. The list endpoint deliberately returns EVERY
 * employee's entries to an admin when no `employeeId` filter is supplied (the
 * admin approval queue needs that). A personal screen must therefore always
 * pass `employeeId`, and the rows must come back newest-first so that "the
 * last shift" is a well-defined row rather than whatever order Postgres
 * happened to return.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, shiftsTable, timeEntriesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `telist-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerId: string;
  adminToken: string;
  officerToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
  adminOldEntryId: string;
  adminNewEntryId: string;
  officerEntryId: string;
};
const ctx = {} as Ctx;

// Three entries, deliberately inserted OUT of chronological order so a missing
// ORDER BY can't accidentally produce the right answer via insertion order.
const OFFICER_IN = new Date("2025-05-02T02:18:00.000Z"); // newest overall
const ADMIN_OLD_IN = new Date("2025-04-28T14:00:00.000Z");
const ADMIN_NEW_IN = new Date("2025-05-01T14:00:00.000Z");
const HOUR = 3600_000;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: role === "admin" ? "Admin" : "Officer",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function insertEntry(employeeId: string, clockIn: Date): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      employeeId,
      clockInTime: clockIn,
      clockOutTime: new Date(clockIn.getTime() + 4 * HOUR),
      hoursWorked: "4.00",
      approvalStatus: "pending",
      confirmationStatus: "awaiting_confirmation",
      originalClockInTime: clockIn,
      originalClockOutTime: new Date(clockIn.getTime() + 4 * HOUR),
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.officerToken = signToken({ userId: ctx.officerId, email: `${TAG}-officer@example.test`, role: "employee" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 List Way", defaultBillRate: "50.00" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: ADMIN_OLD_IN,
      endTime: new Date(ADMIN_OLD_IN.getTime() + 4 * HOUR),
      payRate: "20.00",
      billRate: "40.00",
      headcount: 2,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // Insert order is intentionally NOT chronological.
  ctx.adminOldEntryId = await insertEntry(ctx.adminId, ADMIN_OLD_IN);
  ctx.officerEntryId = await insertEntry(ctx.officerId, OFFICER_IN);
  ctx.adminNewEntryId = await insertEntry(ctx.adminId, ADMIN_NEW_IN);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Only the rows this test created, in the order the endpoint returned them. */
function mine(body: any[]): any[] {
  const ids = new Set([ctx.adminOldEntryId, ctx.adminNewEntryId, ctx.officerEntryId]);
  return body.filter((r) => ids.has(r.id));
}

describe("GET /time-entries scoping", () => {
  it("an employee only ever sees their own entries", async () => {
    const res = await request(app).get("/api/time-entries").set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    const rows = mine(res.body);
    expect(rows.map((r) => r.id)).toEqual([ctx.officerEntryId]);
    expect(rows.every((r) => r.employeeId === ctx.officerId)).toBe(true);
  });

  it("an UNFILTERED admin request returns other employees' entries too", async () => {
    // This is intended for the admin approval queue — and is exactly why a
    // personal screen must not call this endpoint without `employeeId`.
    const res = await request(app).get("/api/time-entries").set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const ids = mine(res.body).map((r) => r.id);
    expect(ids).toContain(ctx.officerEntryId);
    expect(ids).toContain(ctx.adminNewEntryId);
  });

  it("an admin filtering by their own employeeId sees only their own entries", async () => {
    const res = await request(app)
      .get(`/api/time-entries?employeeId=${ctx.adminId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const rows = mine(res.body);
    expect(rows.every((r) => r.employeeId === ctx.adminId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(ctx.officerEntryId);
  });
});

describe("GET /time-entries ordering", () => {
  it("returns rows newest clock-in first, regardless of insertion order", async () => {
    const res = await request(app)
      .get(`/api/time-entries?employeeId=${ctx.adminId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    // Newer admin entry must precede the older one even though the older row
    // was inserted first.
    expect(mine(res.body).map((r) => r.id)).toEqual([ctx.adminNewEntryId, ctx.adminOldEntryId]);
  });

  it("the whole list is monotonically non-increasing by clockInTime", async () => {
    const res = await request(app).get("/api/time-entries").set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const times = (res.body as any[]).map((r) => new Date(r.clockInTime).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });
});
