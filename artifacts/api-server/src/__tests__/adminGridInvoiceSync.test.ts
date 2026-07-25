/**
 * Admin-grid time-entry CRUD must keep the weekly client draft invoice in
 * lockstep — the same pipeline the dedicated approval/correction routes use.
 *
 *   POST   /admin/tables/time_entries      approved insert   → invoice upsert
 *   PUT    /admin/tables/time_entries/:id  approval flips    → add/remove hours
 *   PUT    (bucket move: week change)      old + new buckets both rebuilt
 *   DELETE /admin/tables/time_entries/:id  approved delete   → hours removed
 *
 * Sync is fire-and-forget after the response, so assertions poll briefly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { weekStartIsoBusiness } from "../lib/invoiceSync";

const TAG = `gridinv-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Fixed instants in two DIFFERENT ISO weeks, far in the past (no collision
// with live data, no US federal holiday in either week).
const WEEK1_IN = new Date("2025-09-09T14:00:00.000Z"); // Tuesday
const WEEK1_OUT = new Date("2025-09-09T18:00:00.000Z"); // +4h
const WEEK2_IN = new Date("2025-09-16T14:00:00.000Z"); // next Tuesday
const WEEK2_OUT = new Date("2025-09-16T18:00:00.000Z");

type Ctx = {
  adminId: string;
  officerId: string;
  adminToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const mkUser = async (role: "admin" | "employee", suffix: string) => {
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
  };
  ctx.adminId = await mkUser("admin", "admin");
  ctx.officerId = await mkUser("employee", "officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Grid Sync Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: WEEK1_IN,
      endTime: WEEK1_OUT,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM audit_logs WHERE actor_user_id = ${ctx.adminId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

beforeEach(async () => {
  await db.delete(invoicesTable).where(eq(invoicesTable.siteId, ctx.siteId));
  await db.delete(timeEntriesTable).where(eq(timeEntriesTable.employeeId, ctx.officerId));
});

async function invoiceFor(weekStart: string) {
  const rows = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, weekStart)));
  return rows[0];
}

/** Poll until the (site, week) invoice satisfies `predicate` (sync is async). */
async function waitForInvoice(
  weekStart: string,
  predicate: (inv: typeof invoicesTable.$inferSelect | undefined) => boolean,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  let inv: typeof invoicesTable.$inferSelect | undefined;
  while (Date.now() < deadline) {
    inv = await invoiceFor(weekStart);
    if (predicate(inv)) return inv;
    await new Promise((r) => setTimeout(r, 50));
  }
  return inv;
}

function entryBody(overrides: Record<string, unknown> = {}) {
  return {
    shiftId: ctx.shiftId,
    siteId: ctx.siteId,
    employeeId: ctx.officerId,
    clockInTime: WEEK1_IN.toISOString(),
    clockOutTime: WEEK1_OUT.toISOString(),
    hoursWorked: "4.00",
    approvalStatus: "approved",
    ...overrides,
  };
}

describe("admin grid time-entry CRUD → weekly invoice sync", () => {
  const week1 = weekStartIsoBusiness(WEEK1_IN);
  const week2 = weekStartIsoBusiness(WEEK2_IN);

  it("POST of an approved entry creates the weekly draft invoice", async () => {
    const res = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed(ctx.adminToken))
      .send(entryBody());
    expect(res.status).toBe(201);

    const inv = await waitForInvoice(week1, (i) => !!i && parseFloat(String(i.subtotal)) === 160);
    expect(inv).toBeDefined();
    // 4h @ shift billRate 40 = 160.
    expect(parseFloat(String(inv!.subtotal))).toBe(160);
    expect(inv!.status).toBe("draft");
    expect(inv!.autoSynced).toBe(true);
  });

  it("POST of a pending entry does NOT create an invoice", async () => {
    const res = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed(ctx.adminToken))
      .send(entryBody({ approvalStatus: "pending" }));
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 300));
    expect(await invoiceFor(week1)).toBeUndefined();
  });

  it("PUT flipping pending → approved rolls the hours into the invoice", async () => {
    const created = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed(ctx.adminToken))
      .send(entryBody({ approvalStatus: "pending" }));
    expect(created.status).toBe(201);

    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${created.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ approvalStatus: "approved" });
    expect(res.status).toBe(200);

    const inv = await waitForInvoice(week1, (i) => !!i && parseFloat(String(i.subtotal)) === 160);
    expect(inv).toBeDefined();
    expect(parseFloat(String(inv!.subtotal))).toBe(160);
  });

  it("PUT downgrading approved → rejected removes the hours (empty draft pruned)", async () => {
    const created = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed(ctx.adminToken))
      .send(entryBody());
    expect(created.status).toBe(201);
    await waitForInvoice(week1, (i) => !!i);

    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${created.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ approvalStatus: "rejected" });
    expect(res.status).toBe(200);

    const gone = await waitForInvoice(week1, (i) => i === undefined);
    expect(gone).toBeUndefined();
  });

  it("PUT moving an approved entry to another week rebuilds BOTH week buckets", async () => {
    const created = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed(ctx.adminToken))
      .send(entryBody());
    expect(created.status).toBe(201);
    await waitForInvoice(week1, (i) => !!i && parseFloat(String(i.subtotal)) === 160);

    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${created.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ clockInTime: WEEK2_IN.toISOString(), clockOutTime: WEEK2_OUT.toISOString() });
    expect(res.status).toBe(200);

    // Old week's draft empties out and is pruned; new week's draft is created.
    const oldGone = await waitForInvoice(week1, (i) => i === undefined);
    expect(oldGone).toBeUndefined();
    const moved = await waitForInvoice(week2, (i) => !!i && parseFloat(String(i.subtotal)) === 160);
    expect(moved).toBeDefined();
    expect(parseFloat(String(moved!.subtotal))).toBe(160);
  });

  it("DELETE of an approved entry removes its hours from the invoice", async () => {
    const created = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed(ctx.adminToken))
      .send(entryBody());
    expect(created.status).toBe(201);
    await waitForInvoice(week1, (i) => !!i);

    const res = await request(app)
      .delete(`/api/admin/tables/time_entries/${created.body.id}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(204);

    const gone = await waitForInvoice(week1, (i) => i === undefined);
    expect(gone).toBeUndefined();
  });
});
