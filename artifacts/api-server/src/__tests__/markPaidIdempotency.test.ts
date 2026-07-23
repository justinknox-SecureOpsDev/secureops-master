import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, employeesTable, clientsTable, sitesTable, payrollEntriesTable } from "@workspace/db";

const { default: app } = await import("../app");
const { signToken } = await import("../middlewares/auth");

const TAG = `markpaid-idem-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; employeeId: string; adminToken: string; clientId: string; siteId: string };
const ctx = {} as Ctx;

// Each entry gets a distinct ISO week — payroll_entries has a unique
// (employee, site, period_start) constraint.
let weekCounter = 0;
async function makePendingEntry(): Promise<string> {
  weekCounter += 1;
  const start = new Date(Date.UTC(2026, 2, 2)); // a Monday
  start.setUTCDate(start.getUTCDate() + weekCounter * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const [row] = await db
    .insert(payrollEntriesTable)
    .values({
      employeeId: ctx.employeeId,
      siteId: ctx.siteId,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
      totalHours: "8.00",
      grossPay: "200.00",
      tax: "0",
      netPay: "200.00",
      status: "pending",
    })
    .returning({ id: payrollEntriesTable.id });
  return row.id;
}

beforeAll(async () => {
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
  ctx.adminId = admin.id;
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });

  const [emp] = await db
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
  ctx.employeeId = emp.id;

  await db.insert(employeesTable).values({
    userId: ctx.employeeId,
    bankAccountName: "Officer Banked",
    bankAccountNumber: "1234567890",
    bankBsb: "021000021",
    directDepositConsent: true,
    hourlyRate: "25.00",
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Idem Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.employeeId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
});

describe("POST /payroll/pay-run/mark-paid idempotency", () => {
  it("replays the original response for a duplicate idempotencyKey (no confusing zero-row second result)", async () => {
    const entryId = await makePendingEntry();
    const key = `idem-${randomUUID()}`;

    const first = await request(app)
      .post("/api/payroll/pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [entryId], method: "manual", idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(first.body.marked).toBe(1);

    const second = await request(app)
      .post("/api/payroll/pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [entryId], method: "manual", idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.body.idempotentReplay).toBe(true);
    // Replays the original marked=1, not a fresh marked=0.
    expect(second.body.marked).toBe(1);
  });

  it("dedupes concurrent double-click submissions with the same key", async () => {
    const entryId = await makePendingEntry();
    const key = `idem-${randomUUID()}`;

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/payroll/pay-run/mark-paid")
        .set("Authorization", `Bearer ${ctx.adminToken}`)
        .send({ ids: [entryId], method: "manual", idempotencyKey: key }),
      request(app)
        .post("/api/payroll/pay-run/mark-paid")
        .set("Authorization", `Bearer ${ctx.adminToken}`)
        .send({ ids: [entryId], method: "manual", idempotencyKey: key }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both report marked=1; exactly one is the replay.
    expect(a.body.marked).toBe(1);
    expect(b.body.marked).toBe(1);
    expect([a.body.idempotentReplay, b.body.idempotentReplay]).toContain(true);
  });

  it("still works without an idempotencyKey (backward compatible)", async () => {
    const entryId = await makePendingEntry();
    const res = await request(app)
      .post("/api/payroll/pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [entryId], method: "manual" });
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(res.body.idempotentReplay).toBeUndefined();
  });
});
