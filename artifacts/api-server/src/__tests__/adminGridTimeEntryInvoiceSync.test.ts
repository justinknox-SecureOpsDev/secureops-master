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

const TAG = `gridteinvsync-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  adminToken: string;
  officerId: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

// A fixed instant well in the past — stable ISO week, no collision with live data.
const BASE_CLOCK_IN = new Date("2025-04-08T14:00:00.000Z"); // Tuesday
const BASE_CLOCK_OUT = new Date("2025-04-08T18:00:00.000Z"); // +4h
const WEEK_START = weekStartIsoBusiness(BASE_CLOCK_IN);

// A second week for cross-week move tests.
const NEXT_CLOCK_IN = new Date("2025-04-15T14:00:00.000Z"); // following Tuesday

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
  ctx.adminToken = signToken({ userId: admin.id, email: `${TAG}-admin@example.test`, role: "admin" });

  const [officer] = await db
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
  ctx.officerId = officer.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "1 Grid Sync Ave",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: BASE_CLOCK_IN,
      endTime: BASE_CLOCK_OUT,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 2,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed() {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

/** Poll for an invoice for this site+week matching the predicate. */
async function waitForInvoice(
  siteId: string,
  weekStart: string,
  predicate: (inv: typeof invoicesTable.$inferSelect) => boolean,
  timeoutMs = 3000,
): Promise<typeof invoicesTable.$inferSelect | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Select ALL rows for this (siteId, periodStart) — there may be multiple
    // (e.g. a locked "current" invoice + a new adjustment draft), and we want
    // to find ANY that satisfies the predicate, not just the first one.
    const rows = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, siteId), eq(invoicesTable.periodStart, weekStart)));
    const match = rows.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

async function waitForNoInvoice(siteId: string, weekStart: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, siteId), eq(invoicesTable.periodStart, weekStart)));
    if (rows.length === 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Isolate invoice state before each invoice-related test.
beforeEach(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
});

describe("admin grid POST /admin/tables/time_entries — invoice sync on create", () => {
  it("creates an adjustment draft when adding an approved entry for a locked week", async () => {
    // Lock last week's invoice by stamping locked_at directly.
    await db.insert(invoicesTable).values({
      invoiceNumber: `${TAG}-locked-inv`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart: WEEK_START,
      periodEnd: WEEK_START,
      clientName: `${TAG}-client`,
      lineItems: [],
      subtotal: "0",
      taxAmount: "0",
      totalAmount: "0",
      status: "draft",
      dueDate: "2025-04-30",
      autoSynced: true,
      lockedAt: new Date("2025-04-10T00:00:00.000Z"),
    });

    // Admin adds a missed 4h approved entry via the grid.
    const res = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed())
      .send({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN.toISOString(),
        clockOutTime: BASE_CLOCK_OUT.toISOString(),
        hoursWorked: "4.00",
        approvalStatus: "approved",
      });
    expect(res.status).toBe(201);

    // An adjustment draft (unlocked, autoSynced) should appear for the same week.
    const invoice = await waitForInvoice(
      ctx.siteId,
      WEEK_START,
      (inv) => inv.lockedAt === null && inv.autoSynced === true,
    );
    expect(invoice).toBeDefined();
    // 4h × billRate 40 = 160
    expect(parseFloat(String(invoice!.subtotal))).toBe(160);
  });

  it("creates a draft for an open week when adding an approved entry", async () => {
    const res = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed())
      .send({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN.toISOString(),
        clockOutTime: BASE_CLOCK_OUT.toISOString(),
        hoursWorked: "4.00",
        approvalStatus: "approved",
      });
    expect(res.status).toBe(201);

    const invoice = await waitForInvoice(
      ctx.siteId,
      WEEK_START,
      (inv) => parseFloat(String(inv.subtotal)) === 160,
    );
    expect(invoice).toBeDefined();
    const lines = invoice!.lineItems as Array<{ hours: number; amount: number }>;
    expect(lines[0].hours).toBe(4);
    expect(lines[0].amount).toBe(160);
  });

  it("does NOT create an invoice when adding a pending entry", async () => {
    const res = await request(app)
      .post("/api/admin/tables/time_entries")
      .set(authed())
      .send({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN.toISOString(),
        clockOutTime: BASE_CLOCK_OUT.toISOString(),
        hoursWorked: "4.00",
        approvalStatus: "pending",
      });
    expect(res.status).toBe(201);

    // Give any (incorrect) async sync a chance to fire.
    await new Promise((r) => setTimeout(r, 400));
    const rows = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, WEEK_START)));
    expect(rows).toHaveLength(0);
  });
});

describe("admin grid PUT /admin/tables/time_entries/:id — invoice sync on update", () => {
  it("syncs invoice when flipping a pending entry to approved", async () => {
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN,
        clockOutTime: BASE_CLOCK_OUT,
        hoursWorked: "4.00",
        approvalStatus: "pending",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed())
      .send({ approvalStatus: "approved" });
    expect(res.status).toBe(200);

    const invoice = await waitForInvoice(
      ctx.siteId,
      WEEK_START,
      (inv) => parseFloat(String(inv.subtotal)) === 160,
    );
    expect(invoice).toBeDefined();
  });

  it("updates the draft totals when editing hoursWorked on an approved entry", async () => {
    // Seed an approved entry and its draft invoice.
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN,
        clockOutTime: BASE_CLOCK_OUT,
        hoursWorked: "4.00",
        approvalStatus: "approved",
      })
      .returning({ id: timeEntriesTable.id });

    // Seed the draft invoice first (as the approve route would).
    await db.insert(invoicesTable).values({
      invoiceNumber: `${TAG}-draft`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart: WEEK_START,
      periodEnd: WEEK_START,
      clientName: `${TAG}-client`,
      lineItems: [{ description: "Officer", hours: 4, rate: 40, amount: 160 }],
      subtotal: "160",
      taxAmount: "0",
      totalAmount: "160",
      status: "draft",
      dueDate: "2025-04-30",
      autoSynced: true,
    });

    // Admin edits hoursWorked to 8h via the grid.
    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed())
      .send({ hoursWorked: "8.00" });
    expect(res.status).toBe(200);

    // Draft should now reflect 8h × 40 = 320.
    const invoice = await waitForInvoice(
      ctx.siteId,
      WEEK_START,
      (inv) => parseFloat(String(inv.subtotal)) === 320,
    );
    expect(invoice).toBeDefined();
    expect(parseFloat(String(invoice!.subtotal))).toBe(320);
  });

  it("does NOT sync when editing a pending entry without changing approval status", async () => {
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN,
        clockOutTime: BASE_CLOCK_OUT,
        hoursWorked: "4.00",
        approvalStatus: "pending",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed())
      .send({ hoursWorked: "6.00" });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 400));
    const rows = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, WEEK_START)));
    expect(rows).toHaveLength(0);
  });

  it("re-syncs old invoice when siteId is null and site is derived from shiftId on a week move", async () => {
    // Entry with siteId=null, site resolved from shiftId (the shift has siteId set).
    const PREV_CLOCK_IN = new Date("2025-04-01T14:00:00.000Z"); // week before BASE_CLOCK_IN
    const PREV_WEEK_START = weekStartIsoBusiness(PREV_CLOCK_IN);
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        // siteId intentionally omitted (null) — site must be resolved via shiftId
        clockInTime: PREV_CLOCK_IN,
        clockOutTime: new Date(PREV_CLOCK_IN.getTime() + 4 * 3600_000),
        hoursWorked: "4.00",
        approvalStatus: "approved",
      })
      .returning({ id: timeEntriesTable.id });

    // Seed a draft for the OLD week (the one we're about to move away from).
    await db.insert(invoicesTable).values({
      invoiceNumber: `${TAG}-shiftonly-draft`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart: PREV_WEEK_START,
      periodEnd: PREV_WEEK_START,
      clientName: `${TAG}-client`,
      lineItems: [{ description: "Officer", hours: 4, rate: 40, amount: 160 }],
      subtotal: "160",
      taxAmount: "0",
      totalAmount: "160",
      status: "draft",
      dueDate: "2025-04-30",
      autoSynced: true,
    });

    // Move the entry to the BASE week — the old week's invoice must be re-synced
    // even though the entry's siteId column is null.
    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed())
      .send({ clockInTime: BASE_CLOCK_IN.toISOString(), clockOutTime: BASE_CLOCK_OUT.toISOString() });
    expect(res.status).toBe(200);

    // Old week's draft should be pruned (no approved entries remain there).
    const oldGone = await waitForNoInvoice(ctx.siteId, PREV_WEEK_START, 3000);
    expect(oldGone).toBe(true);

    // Clean up the old-week invoice and the newly-created BASE week draft.
    await db.execute(sql`DELETE FROM invoices WHERE site_id = ${ctx.siteId}::uuid AND period_start = ${BASE_CLOCK_IN.toISOString().slice(0, 10)}`);
  });

  it("removes hours from draft when downgrading an approved entry back to pending", async () => {
    // Seed an approved entry and a matching open draft.
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN,
        clockOutTime: BASE_CLOCK_OUT,
        hoursWorked: "4.00",
        approvalStatus: "approved",
      })
      .returning({ id: timeEntriesTable.id });

    await db.insert(invoicesTable).values({
      invoiceNumber: `${TAG}-downgrade-draft`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart: WEEK_START,
      periodEnd: WEEK_START,
      clientName: `${TAG}-client`,
      lineItems: [{ description: "Officer", hours: 4, rate: 40, amount: 160 }],
      subtotal: "160",
      taxAmount: "0",
      totalAmount: "160",
      status: "draft",
      dueDate: "2025-04-30",
      autoSynced: true,
    });

    // Admin downgrades the entry to pending via the grid.
    const res = await request(app)
      .put(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed())
      .send({ approvalStatus: "pending" });
    expect(res.status).toBe(200);

    // The draft should be pruned: no approved entries remain → sync deletes it.
    const gone = await waitForNoInvoice(ctx.siteId, WEEK_START, 3000);
    expect(gone).toBe(true);
  });
});

describe("admin grid DELETE /admin/tables/time_entries/:id — invoice sync on delete", () => {
  it("removes deleted entry's hours from the open draft invoice", async () => {
    // Approved entry → open draft with 4h billed.
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN,
        clockOutTime: BASE_CLOCK_OUT,
        hoursWorked: "4.00",
        approvalStatus: "approved",
      })
      .returning({ id: timeEntriesTable.id });

    await db.insert(invoicesTable).values({
      invoiceNumber: `${TAG}-del-draft`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart: WEEK_START,
      periodEnd: WEEK_START,
      clientName: `${TAG}-client`,
      lineItems: [{ description: "Officer", hours: 4, rate: 40, amount: 160 }],
      subtotal: "160",
      taxAmount: "0",
      totalAmount: "160",
      status: "draft",
      dueDate: "2025-04-30",
      autoSynced: true,
    });

    const res = await request(app)
      .delete(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed());
    expect(res.status).toBe(204);

    // The draft should be pruned (no approved entries remain → deleted).
    const gone = await waitForNoInvoice(ctx.siteId, WEEK_START, 3000);
    expect(gone).toBe(true);
  });

  it("does NOT trigger sync when deleting a pending (non-approved) entry", async () => {
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        clockInTime: BASE_CLOCK_IN,
        clockOutTime: BASE_CLOCK_OUT,
        hoursWorked: "4.00",
        approvalStatus: "pending",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .delete(`/api/admin/tables/time_entries/${entry.id}`)
      .set(authed());
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 400));
    const rows = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, WEEK_START)));
    expect(rows).toHaveLength(0);
  });
});
