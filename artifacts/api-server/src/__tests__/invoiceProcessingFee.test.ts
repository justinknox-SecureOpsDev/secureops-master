/**
 * Per-site processing fee gate tests.
 *
 * Each site alone owns whether it charges a processing fee and at what rate.
 *
 * Three invariants tested:
 *   (a) fee-enabled site → non-zero processingFeeAmount
 *   (b) fee-disabled site → zero fee
 *
 * Tests target upsertWeeklyInvoice (auto-sync path) and the manual
 * POST /invoices route so both paths are covered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  timeEntriesTable,
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { upsertWeeklyInvoice, weekStartIsoBusiness } from "../lib/invoiceSync";

const TAG = `invfee-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerId: string;
  adminToken: string;
  clientId: string;
  /** Site with processingFeeEnabled=true, processingFeeRate=5.00 */
  feeOnSiteId: string;
  /** Site with processingFeeEnabled=false */
  feeOffSiteId: string;
};
const ctx = {} as Ctx;

// Two fixed instants in different past weeks (no US federal holiday).
const WEEK_IN = new Date("2025-08-05T14:00:00.000Z"); // Tuesday
const WEEK_OUT = new Date("2025-08-05T22:00:00.000Z"); // +8h

async function mkUser(role: "admin" | "employee", suffix: string) {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: role,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

beforeAll(async () => {
  ctx.adminId = await mkUser("admin", "admin");
  ctx.officerId = await mkUser("employee", "officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [feeOnSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-fee-on-site`,
      defaultBillRate: "40.00",
      processingFeeEnabled: true,
      processingFeeRate: "5.00",
    })
    .returning({ id: sitesTable.id });
  ctx.feeOnSiteId = feeOnSite.id;

  const [feeOffSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-fee-off-site`,
      defaultBillRate: "40.00",
      processingFeeEnabled: false,
    })
    .returning({ id: sitesTable.id });
  ctx.feeOffSiteId = feeOffSite.id;

  // Seed an approved time entry on each site for the same past week.
  for (const siteId of [ctx.feeOnSiteId, ctx.feeOffSiteId]) {
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId,
      clockInTime: WEEK_IN,
      clockOutTime: WEEK_OUT,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE site_id IN (${ctx.feeOnSiteId}::uuid, ${ctx.feeOffSiteId}::uuid)`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

// Wipe any invoices created by a test before the next one to keep
// the partial unique index clean (one auto-synced draft per site+week).
async function deleteTestInvoices() {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
}

// ── invoiceSync (auto-sync) path ──────────────────────────────────────────────

describe("upsertWeeklyInvoice — processing fee gate", () => {
  const weekStart = weekStartIsoBusiness(WEEK_IN);

  beforeEach(async () => {
    await deleteTestInvoices();
  });

  it("fee-enabled site adds its configured rate to an auto-synced invoice", async () => {
    const result = await upsertWeeklyInvoice(ctx.feeOnSiteId, weekStart);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const [inv] = await db
      .select({ processingFeeAmount: invoicesTable.processingFeeAmount, processingFeeRate: invoicesTable.processingFeeRate, taxAmount: invoicesTable.taxAmount })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, result.invoiceId));
    // subtotal = 8h × $40 = $320; fee = 5% of $320 = $16
    expect(parseFloat(String(inv.processingFeeAmount ?? "0"))).toBeCloseTo(16, 2);
    expect(parseFloat(String(inv.processingFeeRate ?? "0"))).toBeCloseTo(5, 2);
    expect(parseFloat(String(inv.taxAmount ?? "0"))).toBe(0);
  });

  it("fee-disabled site adds no fee to an auto-synced invoice", async () => {
    const result = await upsertWeeklyInvoice(ctx.feeOffSiteId, weekStart);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const [inv] = await db
      .select({ processingFeeAmount: invoicesTable.processingFeeAmount, processingFeeRate: invoicesTable.processingFeeRate })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, result.invoiceId));
    expect(inv.processingFeeAmount).toBeNull();
    expect(inv.processingFeeRate).toBeNull();
  });
});

// ── Manual POST /invoices path ────────────────────────────────────────────────

describe("POST /invoices — processing fee gate", () => {
  const authed = (t: string) => ({ Authorization: `Bearer ${t}` });
  const lineItems = [{ description: "Security services", amount: 320 }];

  it("fee-enabled site adds its configured rate to a manual invoice", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set(authed(ctx.adminToken))
      .send({
        clientName: `${TAG}-manual-client`,
        siteId: ctx.feeOnSiteId,
        lineItems,
        dueDate: "2099-01-01",
      });
    expect(res.status).toBe(201);
    expect(parseFloat(res.body.processingFeeAmount)).toBeCloseTo(16, 2);
    expect(parseFloat(res.body.processingFeeRate)).toBeCloseTo(5, 2);
    expect(parseFloat(res.body.taxAmount)).toBe(0);
  });

  it("fee-disabled site adds no fee to a manual invoice", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set(authed(ctx.adminToken))
      .send({
        clientName: `${TAG}-manual-client`,
        siteId: ctx.feeOffSiteId,
        lineItems,
        dueDate: "2099-01-01",
      });
    expect(res.status).toBe(201);
    expect(res.body.processingFeeAmount).toBeNull();
    expect(res.body.processingFeeRate).toBeNull();
  });
});
