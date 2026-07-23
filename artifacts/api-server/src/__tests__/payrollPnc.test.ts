import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  payrollEntriesTable,
} from "@workspace/db";

// Mock ONLY the outbound PNC API calls. isPncConfigured and mapRowToInstruction
// stay real so the route's env gating and bank-data validation are exercised.
vi.mock("../lib/pncPayments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pncPayments")>();
  return {
    ...actual,
    submitMultipayment: vi.fn(async (multipaymentId: string) => ({
      ok: true as const,
      multipaymentId,
      raw: { mocked: true },
    })),
    getPaymentStatusByCustomerRef: vi.fn(async () => ({ mocked: true })),
  };
});

import app from "../app";
import { signToken } from "../middlewares/auth";
import { submitMultipayment } from "../lib/pncPayments";
import { recoverStuckProcessingPayrollRows } from "../lib/scheduledJobs";

const submitMock = vi.mocked(submitMultipayment);

const TAG = `pnc-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const PNC_ENV_KEYS = [
  "PNC_CLIENT_ID",
  "PNC_CLIENT_SECRET",
  "PNC_INSTRUCTOR_ACCOUNT_NUMBER",
  "PNC_INSTRUCTOR_ROUTING_NUMBER",
] as const;
const savedEnv: Record<string, string | undefined> = {};

type Ctx = {
  adminId: string;
  bankedEmployeeId: string;
  unbankedEmployeeId: string;
  adminToken: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

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

// Each test inserts its own pending payroll entry so tests stay independent.
// A unique periodStart per row avoids the (employee, site, week) unique index.
let weekCounter = 0;
async function makePendingEntry(employeeId: string): Promise<string> {
  weekCounter += 1;
  const start = new Date(Date.UTC(2020, 0, 6)); // a Monday, safely in the past
  start.setUTCDate(start.getUTCDate() + weekCounter * 7);
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(payrollEntriesTable)
    .values({
      employeeId,
      siteId: ctx.siteId,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
      totalHours: "8.00",
      hourlyRate: "25.00",
      grossPay: "200.00",
      tax: "0",
      netPay: "200.00",
      status: "pending",
    })
    .returning({ id: payrollEntriesTable.id });
  return row.id;
}

async function fetchEntries(ids: string[]) {
  return db
    .select({
      id: payrollEntriesTable.id,
      status: payrollEntriesTable.status,
      paidMethod: payrollEntriesTable.paidMethod,
      paymentReference: payrollEntriesTable.paymentReference,
      paidBy: payrollEntriesTable.paidBy,
    })
    .from(payrollEntriesTable)
    .where(inArray(payrollEntriesTable.id, ids));
}

function authed() {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

beforeAll(async () => {
  for (const k of PNC_ENV_KEYS) savedEnv[k] = process.env[k];
  process.env["PNC_CLIENT_ID"] = "test-client-id";
  process.env["PNC_CLIENT_SECRET"] = "test-client-secret";
  process.env["PNC_INSTRUCTOR_ACCOUNT_NUMBER"] = "000123456789";
  process.env["PNC_INSTRUCTOR_ROUTING_NUMBER"] = "043000096";

  ctx.adminId = await makeUser("admin", "admin");
  ctx.bankedEmployeeId = await makeUser("employee", "banked");
  ctx.unbankedEmployeeId = await makeUser("employee", "unbanked");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });

  await db.insert(employeesTable).values({
    userId: ctx.bankedEmployeeId,
    bankAccountName: "Officer Banked",
    bankAccountNumber: "1234567890",
    bankBsb: "021000021",
    directDepositConsent: true,
    hourlyRate: "25.00",
  });
  // Unbanked: has account number + name but NO routing number, so
  // mapRowToInstruction fails with "Missing routing number".
  await db.insert(employeesTable).values({
    userId: ctx.unbankedEmployeeId,
    bankAccountName: "Officer Unbanked",
    bankAccountNumber: "9876543210",
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
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "100 Pay Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  for (const k of PNC_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  const ids = [ctx.adminId, ctx.bankedEmployeeId, ctx.unbankedEmployeeId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

beforeEach(() => {
  submitMock.mockClear();
  submitMock.mockImplementation(async (multipaymentId: string) => ({
    ok: true as const,
    multipaymentId,
    raw: { mocked: true },
  }));
});

describe("POST /payroll/pay-run/pnc", () => {
  it("returns 503 before any DB work when PNC env vars are missing", async () => {
    const entryId = await makePendingEntry(ctx.bankedEmployeeId);
    const saved = process.env["PNC_CLIENT_ID"];
    delete process.env["PNC_CLIENT_ID"];
    try {
      const res = await request(app)
        .post("/api/payroll/pay-run/pnc")
        .set(authed())
        .send({ ids: [entryId] });
      expect(res.status).toBe(503);
      expect(res.body.configured).toBe(false);
      expect(submitMock).not.toHaveBeenCalled();
      // No DB mutation happened.
      const [row] = await fetchEntries([entryId]);
      expect(row.status).toBe("pending");
      expect(row.paidMethod).toBeNull();
      expect(row.paymentReference).toBeNull();
    } finally {
      process.env["PNC_CLIENT_ID"] = saved;
    }
  });

  it("happy path: pending rows → processed with paidMethod=pnc_api and per-row customerReference", async () => {
    const entryId = await makePendingEntry(ctx.bankedEmployeeId);

    const res = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]![0]).toBe(res.body.multipaymentId);

    const [row] = await fetchEntries([entryId]);
    expect(row.status).toBe("processed");
    expect(row.paidMethod).toBe("pnc_api");
    expect(row.paidBy).toBe(ctx.adminId);
    // paymentReference is the per-row customerReference (queryable via PNC
    // status API), which embeds the entry id — not the batch multipaymentId.
    expect(row.paymentReference).toContain(entryId);
    expect(row.paymentReference).toMatch(/^WCSG-/);
  });

  it("idempotency: re-submitting already-processed ids claims 0 rows and never double-pays", async () => {
    const entryId = await makePendingEntry(ctx.bankedEmployeeId);

    const first = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(first.status).toBe(200);
    expect(first.body.processed).toBe(1);

    const [afterFirst] = await fetchEntries([entryId]);
    expect(afterFirst.status).toBe("processed");
    const firstReference = afterFirst.paymentReference;

    // Second submission of the same ids: the row is no longer 'pending', so
    // loadPayRunRows→pending filter yields nothing → 400, no PNC call, no change.
    const second = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(second.status).toBe(400);
    expect(submitMock).toHaveBeenCalledTimes(1); // only the first request hit PNC

    const [afterSecond] = await fetchEntries([entryId]);
    expect(afterSecond.status).toBe("processed"); // not re-claimed or re-flipped
    expect(afterSecond.paymentReference).toBe(firstReference); // not overwritten
  });

  it("idempotency vs CSV export: rows already processed via CSV cannot also be paid via PNC", async () => {
    const entryId = await makePendingEntry(ctx.bankedEmployeeId);

    const csv = await request(app)
      .post("/api/payroll/pay-run/export-csv")
      .set(authed())
      .send({ ids: [entryId], batchReference: `${TAG}-CSV` });
    expect(csv.status).toBe(200);

    const pnc = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(pnc.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();

    const [row] = await fetchEntries([entryId]);
    expect(row.status).toBe("processed");
    expect(row.paidMethod).toBe("ach_csv"); // CSV bookkeeping untouched
    expect(row.paymentReference).toBe(`${TAG}-CSV`);
  });

  it("missing bank data: one bad row rejects the whole batch with 422 and no rows changed", async () => {
    const goodId = await makePendingEntry(ctx.bankedEmployeeId);
    const badId = await makePendingEntry(ctx.unbankedEmployeeId);

    const res = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [goodId, badId] });

    expect(res.status).toBe(422);
    expect(res.body.skipped).toEqual([
      { rowId: badId, reason: "Missing routing number" },
    ]);
    expect(submitMock).not.toHaveBeenCalled();

    // Nothing touched in the DB — both rows still pending and unclaimed.
    const rows = await fetchEntries([goodId, badId]);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.paidMethod).toBeNull();
      expect(row.paymentReference).toBeNull();
      expect(row.paidBy).toBeNull();
    }
  });

  it("rolls rows back to pending when submitMultipayment throws (network outage)", async () => {
    const entryId = await makePendingEntry(ctx.bankedEmployeeId);
    submitMock.mockImplementationOnce(async () => {
      throw new Error("ECONNRESET: network outage");
    });

    const res = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain("ECONNRESET");

    // Claimed rows rolled from 'processing' back to 'pending' with payment
    // bookkeeping cleared — never stranded in 'processing'.
    const [row] = await fetchEntries([entryId]);
    expect(row.status).toBe("pending");
    expect(row.paidMethod).toBeNull();
    expect(row.paymentReference).toBeNull();
    expect(row.paidBy).toBeNull();

    // After the outage clears, a retry succeeds.
    const retry = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(retry.status).toBe(200);
    expect(retry.body.processed).toBe(1);
    expect(submitMock).toHaveBeenCalledTimes(2);
    const [after] = await fetchEntries([entryId]);
    expect(after.status).toBe("processed");
    expect(after.paidMethod).toBe("pnc_api");
  });

  it("stuck-processing sweep recovers rows left in 'processing' when a rollback failed", async () => {
    const stuckId = await makePendingEntry(ctx.bankedEmployeeId);
    const freshId = await makePendingEntry(ctx.bankedEmployeeId);

    // Simulate the failure the task guards against: rows stranded in
    // 'processing' with stale bookkeeping. `stuckId` was claimed >15m ago
    // (rollback failed); `freshId` is a legitimate in-flight submission
    // claimed just now and must NOT be swept.
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    await db
      .update(payrollEntriesTable)
      .set({ status: "processing", paidMethod: "pnc_api", paymentReference: "WCSG-stuck", paidBy: ctx.adminId, updatedAt: stale })
      .where(eq(payrollEntriesTable.id, stuckId));
    await db
      .update(payrollEntriesTable)
      .set({ status: "processing", paidMethod: "pnc_api", paymentReference: "WCSG-fresh", paidBy: ctx.adminId, updatedAt: new Date() })
      .where(eq(payrollEntriesTable.id, freshId));

    await recoverStuckProcessingPayrollRows();

    const [stuck] = await fetchEntries([stuckId]);
    expect(stuck.status).toBe("pending");
    expect(stuck.paidMethod).toBeNull();
    expect(stuck.paymentReference).toBeNull();
    expect(stuck.paidBy).toBeNull();

    // The recently-claimed row is untouched — the age threshold protects it.
    const [fresh] = await fetchEntries([freshId]);
    expect(fresh.status).toBe("processing");
    expect(fresh.paymentReference).toBe("WCSG-fresh");
  });

  it("rolls rows back to pending when PNC rejects the batch", async () => {
    const entryId = await makePendingEntry(ctx.bankedEmployeeId);
    submitMock.mockImplementationOnce(async () => ({
      ok: false as const,
      errors: [{ code: "TEST_REJECT" }],
      raw: {},
    }));

    const res = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(res.status).toBe(502);

    const [row] = await fetchEntries([entryId]);
    expect(row.status).toBe("pending");
    expect(row.paidMethod).toBeNull();
    expect(row.paymentReference).toBeNull();
    expect(row.paidBy).toBeNull();

    // After rollback, a retry succeeds exactly once.
    const retry = await request(app)
      .post("/api/payroll/pay-run/pnc")
      .set(authed())
      .send({ ids: [entryId] });
    expect(retry.status).toBe(200);
    expect(retry.body.processed).toBe(1);
    const [after] = await fetchEntries([entryId]);
    expect(after.status).toBe("processed");
  });
});
