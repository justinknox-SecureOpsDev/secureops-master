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
  licensesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// All rows are tagged so cleanup can scope precisely and never trample
// real seed data left over from a parallel or aborted run.
const TAG = `shifts-claim-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  employeeAId: string;
  employeeBId: string;
  tokenA: string;
  tokenB: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

async function makeEmployee(suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
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
  ctx.employeeAId = await makeEmployee("a");
  ctx.employeeBId = await makeEmployee("b");

  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  for (const empId of [ctx.employeeAId, ctx.employeeBId]) {
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
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  ctx.tokenA = signToken({
    userId: ctx.employeeAId,
    email: `${TAG}-a@example.test`,
    role: "employee",
  });
  ctx.tokenB = signToken({
    userId: ctx.employeeBId,
    email: `${TAG}-b@example.test`,
    role: "employee",
  });
});

afterAll(async () => {
  const ids = [ctx.employeeAId, ctx.employeeBId].filter(Boolean);
  if (ids.length > 0) {
    await db.execute(
      sql`DELETE FROM shift_assignments WHERE employee_id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})`,
    );
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function insertOpenShift(title: string, headcount: number): Promise<string> {
  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [row] = await db
    .insert(shiftsTable)
    .values({
      title,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      requiredLicenseLevel: 2,
      headcount,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  return row.id;
}

describe("POST /shifts/:id/claim atomic concurrency", () => {
  it("returns one 201 + one 409 when two officers race for the only seat", async () => {
    const shiftId = await insertOpenShift(`${TAG}-race`, 1);

    // True race: two different employees fire concurrently. The claim
    // route's inner transaction locks the shift row with FOR UPDATE,
    // re-checks filled < headcount, and inserts or aborts. Exactly one
    // must win; the loser must surface a clean 409 with the
    // "fully staffed" message (not a 500 or a uniqueness leak).
    const [a, b] = await Promise.all([
      request(app).post(`/api/shifts/${shiftId}/claim`).set(authed(ctx.tokenA)).send({}),
      request(app).post(`/api/shifts/${shiftId}/claim`).set(authed(ctx.tokenB)).send({}),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(
      statuses,
      `expected exactly one 201 and one 409 (got ${a.status},${b.status})`,
    ).toEqual([201, 409]);

    const winner = a.status === 201 ? a : b;
    const loser = a.status === 409 ? a : b;
    expect(winner.body.shiftId).toBe(shiftId);
    expect(winner.body.status).toBe("pending_approval");
    expect(loser.body.error).toBe("Conflict");
    expect(loser.body.message).toMatch(/fully staffed/i);

    // Headcount invariant: no over-fill past 1 no matter how the two
    // transactions interleaved.
    const [{ filled }] = await db
      .select({ filled: sql<number>`count(*)::int` })
      .from(shiftAssignmentsTable)
      .where(sql`${shiftAssignmentsTable.shiftId} = ${shiftId}`);
    expect(filled).toBe(1);
  });

  it("returns a clean 409 when the same officer claims the same shift twice", async () => {
    const shiftId = await insertOpenShift(`${TAG}-dup`, 2);

    const first = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenA))
      .send({});
    expect(first.status).toBe(201);

    // Second tap by the same officer must surface the friendly "already
    // signed up" 409 — NOT a 500 from a transaction aborted by the
    // 23505 unique-violation on (shift_id, employee_id).
    const second = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenA))
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("Conflict");
    expect(second.body.message).toMatch(/already signed up/i);

    // And the duplicate must not have consumed another seat.
    const [{ filled }] = await db
      .select({ filled: sql<number>`count(*)::int` })
      .from(shiftAssignmentsTable)
      .where(sql`${shiftAssignmentsTable.shiftId} = ${shiftId}`);
    expect(filled).toBe(1);
  });

  it("returns 409 when the shift is not upcoming", async () => {
    const shiftId = await insertOpenShift(`${TAG}-closed`, 1);
    await db.execute(sql`UPDATE shifts SET status = 'completed' WHERE id = ${shiftId}::uuid`);

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenA))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no longer open/i);
  });
});

describe("PUT /shifts/:id/assignments/:assignmentId approval authorization", () => {
  it("forbids an officer from self-approving their own pending_approval claim", async () => {
    const shiftId = await insertOpenShift(`${TAG}-selfapprove`, 1);

    // Officer claims the shift — this creates a HELD pending_approval row.
    const claim = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(ctx.tokenA))
      .send({});
    expect(claim.status).toBe(201);
    expect(claim.body.status).toBe("pending_approval");
    const assignmentId = claim.body.id as string;

    // The officer must NOT be able to elevate their own request to accepted.
    const escalate = await request(app)
      .put(`/api/shifts/${shiftId}/assignments/${assignmentId}`)
      .set(authed(ctx.tokenA))
      .send({ status: "accepted" });
    expect(escalate.status).toBe(403);

    // Row must remain pending_approval — approval requires an admin/lead.
    const [row] = await db
      .select({ status: shiftAssignmentsTable.status })
      .from(shiftAssignmentsTable)
      .where(sql`${shiftAssignmentsTable.id} = ${assignmentId}::uuid`);
    expect(row.status).toBe("pending_approval");
  });
});
