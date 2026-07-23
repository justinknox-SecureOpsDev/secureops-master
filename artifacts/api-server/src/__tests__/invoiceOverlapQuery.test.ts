import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, invoicesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `invoverlap-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  adminToken: string;
  clientId: string;
  siteId: string;
  // Non-void invoice covering 2026-03-09 .. 2026-03-15 (a Mon..Sun week).
  liveInvoiceId: string;
  // Void invoice covering the exact same range — must never be flagged.
  voidInvoiceId: string;
};
const ctx = {} as Ctx;

// Fixed, disjoint calendar range so nothing else in the suite collides.
const PERIOD_START = "2026-03-09";
const PERIOD_END = "2026-03-15";

async function makeInvoice(
  status: string,
  periodStart: string,
  periodEnd: string,
): Promise<string> {
  const [row] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: `${TAG}-${randomUUID().slice(0, 8)}`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart,
      periodEnd,
      clientName: `${TAG}-client`,
      lineItems: [],
      subtotal: "0",
      totalAmount: "0",
      status,
      dueDate: periodEnd,
    })
    .returning({ id: invoicesTable.id });
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

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Overlap Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  ctx.liveInvoiceId = await makeInvoice("draft", PERIOD_START, PERIOD_END);
  ctx.voidInvoiceId = await makeInvoice("void", PERIOD_START, PERIOD_END);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function overlapQuery(overlapStart: string, overlapEnd: string) {
  return request(app)
    .get("/api/invoices")
    .query({ clientId: ctx.clientId, overlapStart, overlapEnd })
    .set(authed(ctx.adminToken));
}

describe("GET /invoices double-billing overlap filter", () => {
  it("flags an invoice whose period fully contains the requested range", async () => {
    const res = await overlapQuery("2026-03-10", "2026-03-12");
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(ctx.liveInvoiceId);
    expect(ids).not.toContain(ctx.voidInvoiceId);
  });

  it("flags an exact-boundary overlap where existing end == requested start", async () => {
    // Existing period ends 2026-03-15; a new range that STARTS on 2026-03-15
    // shares exactly that one day and must be flagged (inclusive boundary).
    const res = await overlapQuery("2026-03-15", "2026-03-21");
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(ctx.liveInvoiceId);
    expect(ids).not.toContain(ctx.voidInvoiceId);
  });

  it("flags an exact-boundary overlap where existing start == requested end", async () => {
    // Existing period starts 2026-03-09; a new range that ENDS on 2026-03-09
    // shares exactly that one day and must be flagged.
    const res = await overlapQuery("2026-03-03", "2026-03-09");
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(ctx.liveInvoiceId);
  });

  it("does NOT flag a range that ends the day before the existing period", async () => {
    // Requested range ends 2026-03-08, existing starts 2026-03-09 — disjoint.
    const res = await overlapQuery("2026-03-01", "2026-03-08");
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(ctx.liveInvoiceId);
    expect(ids).not.toContain(ctx.voidInvoiceId);
  });

  it("does NOT flag a range that starts the day after the existing period", async () => {
    // Requested range starts 2026-03-16, existing ends 2026-03-15 — disjoint.
    const res = await overlapQuery("2026-03-16", "2026-03-22");
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(ctx.liveInvoiceId);
    expect(ids).not.toContain(ctx.voidInvoiceId);
  });

  it("excludes void invoices even when their period overlaps exactly", async () => {
    const res = await overlapQuery(PERIOD_START, PERIOD_END);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(ctx.liveInvoiceId);
    expect(ids).not.toContain(ctx.voidInvoiceId);
  });

  it("returns 400 when only overlapStart is provided", async () => {
    const res = await request(app)
      .get("/api/invoices")
      .query({ clientId: ctx.clientId, overlapStart: PERIOD_START })
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/overlapStart and overlapEnd/i);
  });

  it("returns 400 when only overlapEnd is provided", async () => {
    const res = await request(app)
      .get("/api/invoices")
      .query({ clientId: ctx.clientId, overlapEnd: PERIOD_END })
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/overlapStart and overlapEnd/i);
  });

  it("returns 400 for a malformed date param", async () => {
    const res = await overlapQuery("2026-3-9", PERIOD_END);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/YYYY-MM-DD/);
  });

  it("returns 400 for a non-date string param", async () => {
    const res = await overlapQuery("not-a-date", "also-bad");
    expect(res.status).toBe(400);
  });

  it("ignores the overlap filter entirely when neither param is present", async () => {
    // No overlap params -> the void invoice is NOT excluded by the overlap
    // branch, proving the exclusion is scoped to the double-billing check.
    const res = await request(app)
      .get("/api/invoices")
      .query({ clientId: ctx.clientId })
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(ctx.liveInvoiceId);
    expect(ids).toContain(ctx.voidInvoiceId);
  });
});
