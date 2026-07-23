import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, employeesTable, payrollEntriesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// POST /payroll/pay-run/pnc-preflight — dry-run PNC readiness check.
// Must apply the same per-row bank-data gate as the real submit route,
// report ALL missing fields per row, exclude non-pending rows, and make
// zero DB writes (statuses stay untouched).

const TAG = `pnc-preflight-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const PNC_ENV_KEYS = [
  "PNC_CLIENT_ID",
  "PNC_CLIENT_SECRET",
  "PNC_INSTRUCTOR_ACCOUNT_NUMBER",
  "PNC_INSTRUCTOR_ROUTING_NUMBER",
] as const;
const savedEnv: Record<string, string | undefined> = {};

type Ctx = {
  adminToken: string;
  adminId: string;
  bankedUserId: string;
  unbankedUserId: string;
  noConsentUserId: string;
  bankedEntryId: string;
  unbankedEntryId: string;
  noConsentEntryId: string;
  paidEntryId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeEntry(employeeId: string, status: string): Promise<string> {
  const [row] = await db
    .insert(payrollEntriesTable)
    .values({
      employeeId,
      periodStart: "2026-07-06",
      periodEnd: "2026-07-12",
      totalHours: "8.00",
      hourlyRate: "25.00",
      grossPay: "200.00",
      tax: "0",
      netPay: "200.00",
      status,
    })
    .returning({ id: payrollEntriesTable.id });
  return row.id;
}

beforeAll(async () => {
  // Fake PNC credentials so isPncConfigured() passes — preflight makes no
  // outbound calls, so the values are never used against a real API.
  for (const k of PNC_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    process.env[k] = process.env[k] || `test-${k.toLowerCase()}`;
  }

  ctx.adminId = await makeUser("admin", "admin");
  ctx.bankedUserId = await makeUser("employee", "banked");
  ctx.unbankedUserId = await makeUser("employee", "unbanked");
  ctx.noConsentUserId = await makeUser("employee", "noconsent");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });

  await db.insert(employeesTable).values({
    userId: ctx.bankedUserId,
    bankAccountName: "Banked Officer",
    bankAccountNumber: "1234567890",
    bankBsb: "021000021",
    directDepositConsent: true,
    hourlyRate: "25.00",
  });
  // Missing ALL THREE bank fields — preflight must list every gap, not
  // just the first one mapRowToInstruction happens to hit.
  await db.insert(employeesTable).values({
    userId: ctx.unbankedUserId,
    directDepositConsent: false,
    hourlyRate: "25.00",
  });
  // Fully banked but NO direct-deposit consent — must be READY (warn-only),
  // carrying a non-blocking consent warning.
  await db.insert(employeesTable).values({
    userId: ctx.noConsentUserId,
    bankAccountName: "No Consent Officer",
    bankAccountNumber: "9876543210",
    bankBsb: "021000021",
    directDepositConsent: false,
    hourlyRate: "25.00",
  });

  ctx.bankedEntryId = await makeEntry(ctx.bankedUserId, "pending");
  ctx.unbankedEntryId = await makeEntry(ctx.unbankedUserId, "pending");
  ctx.noConsentEntryId = await makeEntry(ctx.noConsentUserId, "pending");
  ctx.paidEntryId = await makeEntry(ctx.bankedUserId, "paid");
});

afterAll(async () => {
  for (const k of PNC_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed() {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

describe("POST /payroll/pay-run/pnc-preflight", () => {
  it("splits rows into ready vs excluded with full reason lists", async () => {
    const res = await request(app)
      .post("/api/payroll/pay-run/pnc-preflight")
      .set(authed())
      .send({ ids: [ctx.bankedEntryId, ctx.unbankedEntryId, ctx.noConsentEntryId, ctx.paidEntryId] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 4, ready: 2, excluded: 2 });

    const readyById = new Map<string, { warnings: string[] }>(
      res.body.ready.map((r: { id: string; warnings: string[] }) => [r.id, r]),
    );
    expect(readyById.has(ctx.bankedEntryId)).toBe(true);
    expect(readyById.has(ctx.noConsentEntryId)).toBe(true);
    expect(res.body.readyNetTotal).toBe("400.00");

    // Fully banked + consented → ready with no warnings.
    expect(readyById.get(ctx.bankedEntryId)!.warnings).toEqual([]);
    // Fully banked but no consent → warn-only, still ready (not excluded).
    expect(readyById.get(ctx.noConsentEntryId)!.warnings).toEqual([
      "Direct-deposit consent not on file",
    ]);

    const byId = new Map<string, { reasons: string[]; employeeName: string | null }>(
      res.body.excluded.map((r: { id: string; reasons: string[]; employeeName: string | null }) => [r.id, r]),
    );
    // Unbanked pending row: ALL three missing bank fields reported.
    const unbanked = byId.get(ctx.unbankedEntryId)!;
    expect(unbanked.reasons).toEqual(
      expect.arrayContaining([
        "Missing routing number",
        "Missing bank account number",
        "Missing bank account name",
      ]),
    );
    expect(unbanked.employeeName).toContain("unbanked");
    // Paid row excluded for status, not bank data.
    expect(byId.get(ctx.paidEntryId)!.reasons).toEqual(["Not pending (status: paid)"]);
  });

  it("is a pure dry-run — no row statuses change", async () => {
    const rows = await db.execute(
      sql`SELECT id, status FROM payroll_entries WHERE id IN (${ctx.bankedEntryId}, ${ctx.unbankedEntryId}, ${ctx.paidEntryId})`,
    );
    const statuses = new Map((rows.rows as { id: string; status: string }[]).map((r) => [r.id, r.status]));
    expect(statuses.get(ctx.bankedEntryId)).toBe("pending");
    expect(statuses.get(ctx.unbankedEntryId)).toBe("pending");
    expect(statuses.get(ctx.paidEntryId)).toBe("paid");
  });

  it("rejects an empty ids array", async () => {
    const res = await request(app)
      .post("/api/payroll/pay-run/pnc-preflight")
      .set(authed())
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it("requires admin", async () => {
    const officerToken = signToken({
      userId: ctx.bankedUserId,
      email: `${TAG}-banked@example.test`,
      role: "employee",
    });
    const res = await request(app)
      .post("/api/payroll/pay-run/pnc-preflight")
      .set({ Authorization: `Bearer ${officerToken}` })
      .send({ ids: [ctx.bankedEntryId] });
    expect(res.status).toBe(403);
  });
});
