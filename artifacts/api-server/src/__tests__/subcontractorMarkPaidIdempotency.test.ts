import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, subcontractorsTable, subcontractorInvoicesTable } from "@workspace/db";

const { default: app } = await import("../app");
const { signToken } = await import("../middlewares/auth");

const TAG = `subpay-idem-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; adminToken: string; subcontractorId: string };
const ctx = {} as Ctx;

async function makeApprovedInvoice(): Promise<string> {
  const [row] = await db
    .insert(subcontractorInvoicesTable)
    .values({
      subcontractorId: ctx.subcontractorId,
      invoiceNumber: `${TAG}-${randomUUID().slice(0, 6)}`,
      totalAmount: "500.00",
      status: "approved",
    })
    .returning({ id: subcontractorInvoicesTable.id });
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

  const [sub] = await db
    .insert(subcontractorsTable)
    .values({
      companyName: `${TAG}-vendor`,
      bankAccountName: "Vendor Banked",
      bankAccountNumber: "1234567890",
      bankRoutingNumber: "021000021",
      directDepositConsent: true,
    })
    .returning({ id: subcontractorsTable.id });
  ctx.subcontractorId = sub.id;
});

afterAll(async () => {
  if (ctx.subcontractorId) {
    await db.execute(sql`DELETE FROM subcontractor_invoices WHERE subcontractor_id = ${ctx.subcontractorId}`);
    await db.execute(sql`DELETE FROM subcontractors WHERE id = ${ctx.subcontractorId}`);
  }
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${TAG + "%"}`);
});

describe("POST /subcontractor-pay-run/mark-paid idempotency", () => {
  it("replays the original response for a duplicate idempotencyKey (no confusing zero-row second result)", async () => {
    const invoiceId = await makeApprovedInvoice();
    const key = `idem-${randomUUID()}`;

    const first = await request(app)
      .post("/api/subcontractor-pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [invoiceId], method: "manual", idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(first.body.marked).toBe(1);

    const second = await request(app)
      .post("/api/subcontractor-pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [invoiceId], method: "manual", idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    // Replays the original marked=1, not a fresh marked=0.
    expect(second.body.marked).toBe(1);
  });

  it("dedupes concurrent double-click submissions with the same key", async () => {
    const invoiceId = await makeApprovedInvoice();
    const key = `idem-${randomUUID()}`;

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/subcontractor-pay-run/mark-paid")
        .set("Authorization", `Bearer ${ctx.adminToken}`)
        .send({ ids: [invoiceId], method: "manual", idempotencyKey: key }),
      request(app)
        .post("/api/subcontractor-pay-run/mark-paid")
        .set("Authorization", `Bearer ${ctx.adminToken}`)
        .send({ ids: [invoiceId], method: "manual", idempotencyKey: key }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both report marked=1; exactly one is the replay.
    expect(a.body.marked).toBe(1);
    expect(b.body.marked).toBe(1);
    expect([a.headers["x-idempotent-replay"], b.headers["x-idempotent-replay"]]).toContain("true");
  });

  it("a failed attempt is not pinned — a deliberate retry with the same key still works", async () => {
    const key = `idem-${randomUUID()}`;

    // First attempt fails validation (empty ids[]) before any write happens.
    const first = await request(app)
      .post("/api/subcontractor-pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [], method: "manual", idempotencyKey: key });
    expect(first.status).toBe(400);

    // Retrying with the SAME key against a real, payable invoice must still
    // perform the write — a 4xx/5xx outcome is evicted, not pinned, so fixing
    // the request and retrying is not blocked by the earlier failure.
    const invoiceId = await makeApprovedInvoice();
    const second = await request(app)
      .post("/api/subcontractor-pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [invoiceId], method: "manual", idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.body.marked).toBe(1);
    expect(second.headers["x-idempotent-replay"]).toBeUndefined();
  });

  it("still works without an idempotencyKey (backward compatible)", async () => {
    const invoiceId = await makeApprovedInvoice();
    const res = await request(app)
      .post("/api/subcontractor-pay-run/mark-paid")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ ids: [invoiceId], method: "manual" });
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(res.headers["x-idempotent-replay"]).toBeUndefined();
  });
});
