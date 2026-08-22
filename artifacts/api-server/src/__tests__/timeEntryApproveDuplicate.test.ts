import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, timeEntriesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Approving a time entry releases its hours to payroll and to the client
 * invoice. Nothing about the route refuses an entry that already carries a
 * decision, so re-running it re-stamps the approval and rolls the same hours
 * up again — the most expensive duplicate in the app.
 *
 * An idempotency key protects the retry of one interrupted request, but only
 * for as long as the caller still holds that key. The press that arrives after
 * that — a stale list still reading "Pending", a second admin's tab, a phone
 * that was offline — carries a fresh key and is a different request entirely.
 * So the route itself has to treat "decide it the way it is already decided"
 * as no decision at all, while still letting a genuine change through.
 */

const TAG = `teapprovedup-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const CLOCK_IN = new Date("2025-05-06T14:00:00.000Z"); // a Tuesday
const CLOCK_OUT = new Date("2025-05-06T22:00:00.000Z"); // +8h

const ctx = {} as {
  adminId: string;
  adminToken: string;
  officerId: string;
  clientId: string;
  siteId: string;
  // Separate admins for the concurrency case, so the row itself records which
  // single request actually decided the entry.
  racers: Array<{ id: string; token: string }>;
};

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

async function insertPendingEntry(): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      siteId: ctx.siteId,
      employeeId: ctx.officerId,
      clockInTime: CLOCK_IN,
      clockOutTime: CLOCK_OUT,
      hoursWorked: "8.00",
      approvalStatus: "pending",
      confirmationStatus: "confirmed",
      originalClockInTime: CLOCK_IN,
      originalClockOutTime: CLOCK_OUT,
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

async function getEntry(id: string) {
  const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  return row;
}

function decide(id: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/time-entries/${id}/approve`)
    .set("Authorization", `Bearer ${ctx.adminToken}`)
    .send(body);
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Approve Way", defaultBillRate: "50.00" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  ctx.racers = [];
  for (let i = 0; i < 6; i++) {
    const suffix = `racer${i}`;
    const racerId = await makeUser("admin", suffix);
    ctx.racers.push({
      id: racerId,
      token: signToken({ userId: racerId, email: `${TAG}-${suffix}@example.test`, role: "admin" }),
    });
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM audit_logs WHERE actor_email LIKE ${`${TAG}-%`}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("POST /time-entries/:id/approve — a repeated decision", () => {
  it("does not approve a second time, whatever key the repeat carries", async () => {
    const id = await insertPendingEntry();

    const first = await decide(id, { decision: "approved" });
    expect(first.status).toBe(200);
    const afterFirst = await getEntry(id);
    expect(afterFirst.approvalStatus).toBe("approved");

    // A brand-new key, i.e. the press the client no longer recognises as the
    // same intent — replay protection cannot help here.
    const repeat = await request(app)
      .post(`/api/time-entries/${id}/approve`)
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ decision: "approved" });

    // The admin is told what the entry is, not that something went wrong.
    expect(repeat.status).toBe(200);
    expect(repeat.body.approvalStatus).toBe("approved");
    // The approval is the FIRST one: not re-stamped, so the hours were not
    // released to payroll and the invoice a second time.
    const afterRepeat = await getEntry(id);
    expect(afterRepeat.approvedAt?.getTime()).toBe(afterFirst.approvedAt?.getTime());
    expect(new Date(repeat.body.approvedAt).getTime()).toBe(afterFirst.approvedAt?.getTime());
  });

  it("does not re-run a rejection either", async () => {
    const id = await insertPendingEntry();

    expect((await decide(id, { decision: "rejected" })).status).toBe(200);
    const afterFirst = await getEntry(id);

    expect((await decide(id, { decision: "rejected" })).status).toBe(200);
    const afterRepeat = await getEntry(id);
    expect(afterRepeat.approvalStatus).toBe("rejected");
    expect(afterRepeat.approvedAt?.getTime()).toBe(afterFirst.approvedAt?.getTime());
  });

  it("still lets the approver change their mind", async () => {
    const id = await insertPendingEntry();

    expect((await decide(id, { decision: "approved" })).status).toBe(200);
    const afterApproval = await getEntry(id);

    const rejection = await decide(id, { decision: "rejected" });
    expect(rejection.status).toBe(200);
    const afterRejection = await getEntry(id);
    expect(afterRejection.approvalStatus).toBe("rejected");
    expect(afterRejection.isVerified).toBe(false);
    expect(afterRejection.approvedAt?.getTime()).not.toBe(afterApproval.approvedAt?.getTime());
  });

  it("still applies a correction sent with the same decision", async () => {
    const id = await insertPendingEntry();

    expect((await decide(id, { decision: "approved", hoursWorked: 8 })).status).toBe(200);

    // Same decision, corrected hours — a real change, not a repeat.
    const corrected = await decide(id, { decision: "approved", hoursWorked: 7.5, notes: "Left 30 min early" });
    expect(corrected.status).toBe(200);
    const row = await getEntry(id);
    expect(Number(row.hoursWorked)).toBe(7.5);
    expect(row.notes).toBe("Left 30 min early");
  });

  it("applies exactly one approval when several presses land at the same instant", async () => {
    const id = await insertPendingEntry();

    // Six presses, six different admins, six different keys — nothing a client
    // can dedupe, and they arrive together, so every one of them reads the
    // entry as "pending" before any of them has written. Only the write itself
    // can decide who wins.
    const responses = await Promise.all(
      ctx.racers.map((racer) =>
        request(app)
          .post(`/api/time-entries/${id}/approve`)
          .set("Authorization", `Bearer ${racer.token}`)
          .set("Idempotency-Key", randomUUID())
          .send({ decision: "approved" }),
      ),
    );

    // Nobody is told their approval failed — the losers are told what the
    // entry is.
    for (const r of responses) expect(r.status).toBe(200);

    const row = await getEntry(id);
    expect(row.approvalStatus).toBe("approved");

    // Every answer describes the SAME approval: one approver, one stamp. A
    // second request that got through would have re-stamped approvedAt (and
    // rolled the same hours into the invoice again), leaving the earlier
    // answers describing an approval the row no longer carries.
    const stamps = new Set(
      responses.map((r) => `${r.body.approvedBy}@${new Date(r.body.approvedAt).getTime()}`),
    );
    expect(stamps.size).toBe(1);
    expect(row.approvedAt?.getTime()).toBe(new Date(responses[0].body.approvedAt).getTime());
    expect(row.approvedBy).toBe(responses[0].body.approvedBy);
    // The winner is one of the racers, not some merged state.
    expect(ctx.racers.map((r) => r.id)).toContain(row.approvedBy);
  });

  it("still force-clears an entry the officer never confirmed", async () => {
    const id = await insertPendingEntry();
    await db
      .update(timeEntriesTable)
      .set({ approvalStatus: "approved", isVerified: true, confirmationStatus: "awaiting_confirmation" })
      .where(eq(timeEntriesTable.id, id));

    // Already "approved", but the awaiting state still has to be cleared or
    // the entry sits outside payroll's reach.
    expect((await decide(id, { decision: "approved" })).status).toBe(200);
    const row = await getEntry(id);
    expect(row.confirmationStatus).toBe("confirmed");
  });
});
