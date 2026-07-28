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
  timeEntriesTable,
  invoicesTable,
  subcontractorTimeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * GET /invoices/:id/entries — the Invoice Board drill-down (Task: show
 * clock-in times in invoice detail).
 *
 * The endpoint recomputes the invoice period's individual work sessions with
 * the SAME shared helper the generators use, so:
 *   - clock-in/clock-out/hours must match what was billed,
 *   - the reconciliation flag must be true for a fresh auto-generated
 *     invoice and flip false when entries change or the invoice is
 *     hand-edited,
 *   - subcontractor and unpriced entries must be represented,
 *   - an invoice with no linked site/period returns an empty flagged
 *     result, not an error.
 */

const TAG = `inventries-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  officerId: string;
  adminToken: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
  invoiceId: string;
  officerEntryId: string;
  clockIn: Date;
  clockOut: Date;
  subIn: Date;
  subOut: Date;
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

function previousMondayISO(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const back = day === 0 ? 13 : 6 + day;
  d.setUTCDate(d.getUTCDate() - back);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.employeeId = await makeUser("employee", "emp");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.employeeToken = signToken({ userId: ctx.employeeId, email: `${TAG}-emp@example.test`, role: "employee" });

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
      address: "100 Detail Way",
      defaultBillRate: "42.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const weekStart = new Date(`${previousMondayISO()}T00:00:00.000Z`);
  // Wednesday 09:00 UTC — safely inside the Central business week.
  ctx.clockIn = new Date(weekStart.getTime() + 2 * 86400_000 + 9 * 3600_000);
  ctx.clockOut = new Date(ctx.clockIn.getTime() + 8 * 3600_000);

  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: ctx.officerId,
      siteId: ctx.siteId,
      clockInTime: ctx.clockIn,
      clockOutTime: ctx.clockOut,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    })
    .returning({ id: timeEntriesTable.id });
  ctx.officerEntryId = entry.id;

  // Closed subcontractor entry the next day, 4h.
  ctx.subIn = new Date(ctx.clockIn.getTime() + 86400_000);
  ctx.subOut = new Date(ctx.subIn.getTime() + 4 * 3600_000);
  await db.insert(subcontractorTimeEntriesTable).values({
    siteId: ctx.siteId,
    name: `${TAG}-Sub`,
    company: `${TAG}-Co`,
    clockInAt: ctx.subIn,
    clockOutAt: ctx.subOut,
    hoursWorked: "4.00",
  });

  const res = await request(app)
    .post("/api/invoices/generate")
    .set(authed(ctx.adminToken))
    .send({ siteId: ctx.siteId, weekStart: previousMondayISO() });
  if (res.status !== 201) throw new Error(`generate failed: ${res.status} ${JSON.stringify(res.body)}`);
  ctx.invoiceId = res.body.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM subcontractor_time_entries WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("GET /invoices/:id/entries", () => {
  it("returns the officer session with exact clock-in/clock-out and reconciles with the line items", async () => {
    const res = await request(app)
      .get(`/api/invoices/${ctx.invoiceId}/entries`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.unresolved).toBe(false);
    expect(res.body.reconciled).toBe(true);

    const officer = res.body.entries.find(
      (e: { kind: string; entryId: string }) => e.kind === "officer" && e.entryId === ctx.officerEntryId,
    );
    expect(officer).toBeTruthy();
    expect(officer.clockIn).toBe(ctx.clockIn.toISOString());
    expect(officer.clockOut).toBe(ctx.clockOut.toISOString());
    expect(officer.hours).toBe(8);
    expect(officer.rate).toBe(42);
    expect(officer.billable).toBe(true);
    expect(officer.unpriced).toBe(false);
    expect(officer.description).toBe(`Officer ${TAG}`);

    // Session hours per line item sum to that line item's billed hours.
    const [inv] = await db.select().from(invoicesTable).where(sql`id = ${ctx.invoiceId}::uuid`);
    const lineItems = inv.lineItems as Array<{ description: string; hours: number }>;
    for (const li of lineItems) {
      const sum = res.body.entries
        .filter((e: { description: string }) => e.description === li.description)
        .reduce((acc: number, e: { hours: number }) => acc + e.hours, 0);
      expect(Math.round(sum * 100) / 100).toBe(li.hours);
    }
  });

  it("represents the subcontractor session with its own clock-in/clock-out", async () => {
    const res = await request(app)
      .get(`/api/invoices/${ctx.invoiceId}/entries`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const sub = res.body.entries.find((e: { kind: string }) => e.kind === "subcontractor");
    expect(sub).toBeTruthy();
    expect(sub.workerName).toBe(`${TAG}-Sub (${TAG}-Co)`);
    expect(sub.clockIn).toBe(ctx.subIn.toISOString());
    expect(sub.clockOut).toBe(ctx.subOut.toISOString());
    expect(sub.hours).toBe(4);
    expect(sub.rate).toBe(42);
    expect(sub.description).toContain("subcontractor");
  });

  it("flips reconciled=false when an entry is un-approved, and back when re-approved", async () => {
    await db.execute(
      sql`UPDATE time_entries SET approval_status = 'pending' WHERE id = ${ctx.officerEntryId}::uuid`,
    );
    const changed = await request(app)
      .get(`/api/invoices/${ctx.invoiceId}/entries`)
      .set(authed(ctx.adminToken));
    expect(changed.status).toBe(200);
    expect(changed.body.reconciled).toBe(false);
    // The un-approved entry is no longer returned as a billable session.
    expect(
      changed.body.entries.some((e: { entryId: string }) => e.entryId === ctx.officerEntryId),
    ).toBe(false);

    await db.execute(
      sql`UPDATE time_entries SET approval_status = 'approved' WHERE id = ${ctx.officerEntryId}::uuid`,
    );
    const restored = await request(app)
      .get(`/api/invoices/${ctx.invoiceId}/entries`)
      .set(authed(ctx.adminToken));
    expect(restored.body.reconciled).toBe(true);
  });

  it("flips reconciled=false when the invoice's line items are hand-edited", async () => {
    const put = await request(app)
      .put(`/api/invoices/${ctx.invoiceId}`)
      .set(authed(ctx.adminToken))
      .send({
        lineItems: [{ description: "Hand-edited coverage", hours: 10, rate: 99, amount: 990 }],
      });
    expect(put.status).toBe(200);

    const res = await request(app)
      .get(`/api/invoices/${ctx.invoiceId}/entries`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(false);
    // The live sessions are still returned so the admin can compare.
    expect(res.body.entries.length).toBeGreaterThan(0);
  });

  it("returns unpriced entries for approved hours with no bill rate", async () => {
    // Site with NO defaultBillRate: one entry priced via its shift's own
    // billRate, one ad-hoc entry unpriced.
    const [site] = await db
      .insert(sitesTable)
      .values({ clientId: ctx.clientId, name: `${TAG}-unpriced-site`, address: "200 Unpriced Way" })
      .returning({ id: sitesTable.id });
    const weekStart = new Date(`${previousMondayISO()}T00:00:00.000Z`);
    const shiftIn = new Date(weekStart.getTime() + 86400_000 + 9 * 3600_000);
    const shiftOut = new Date(shiftIn.getTime() + 8 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-priced-shift`,
        siteId: site.id,
        startTime: shiftIn,
        endTime: shiftOut,
        requiredLicenseLevel: 2,
        headcount: 1,
        status: "completed",
        payRate: "25.00",
        billRate: "30.00",
      })
      .returning({ id: shiftsTable.id });
    await db.insert(timeEntriesTable).values({
      shiftId: shift.id,
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: shiftIn,
      clockOutTime: shiftOut,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });
    const adhocIn = new Date(weekStart.getTime() + 2 * 86400_000 + 9 * 3600_000);
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: adhocIn,
      clockOutTime: new Date(adhocIn.getTime() + 3.5 * 3600_000),
      hoursWorked: "3.50",
      approvalStatus: "approved",
    });

    const gen = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart: previousMondayISO() });
    expect(gen.status).toBe(201);

    const res = await request(app)
      .get(`/api/invoices/${gen.body.id}/entries`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.unpricedHours).toBe(3.5);
    const unpriced = res.body.entries.filter((e: { unpriced: boolean }) => e.unpriced);
    expect(unpriced.length).toBe(1);
    expect(unpriced[0].hours).toBe(3.5);
    expect(unpriced[0].rate).toBeNull();
    expect(unpriced[0].billable).toBe(false);
  });

  it("disambiguates line items sharing a description by level+rate", async () => {
    // Same officer twice in one week: one ad-hoc entry at the site rate
    // ($42, no level) and one riding a shift with its own bill rate ($55,
    // level 3). Billing produces TWO line items with the SAME description,
    // so the drill-down must expose level+rate per entry to scope sessions
    // to the exact billed grouping.
    const [site] = await db
      .insert(sitesTable)
      .values({ clientId: ctx.clientId, name: `${TAG}-dup-site`, address: "300 Dup Way", defaultBillRate: "42.00" })
      .returning({ id: sitesTable.id });
    const weekStart = new Date(`${previousMondayISO()}T00:00:00.000Z`);
    const adhocIn = new Date(weekStart.getTime() + 86400_000 + 9 * 3600_000);
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: adhocIn,
      clockOutTime: new Date(adhocIn.getTime() + 8 * 3600_000),
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });
    const shiftIn = new Date(weekStart.getTime() + 2 * 86400_000 + 9 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-dup-shift`,
        siteId: site.id,
        startTime: shiftIn,
        endTime: new Date(shiftIn.getTime() + 4 * 3600_000),
        requiredLicenseLevel: 3,
        headcount: 1,
        status: "completed",
        payRate: "25.00",
        billRate: "55.00",
      })
      .returning({ id: shiftsTable.id });
    await db.insert(timeEntriesTable).values({
      shiftId: shift.id,
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: shiftIn,
      clockOutTime: new Date(shiftIn.getTime() + 4 * 3600_000),
      hoursWorked: "4.00",
      approvalStatus: "approved",
    });

    const gen = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart: previousMondayISO() });
    expect(gen.status).toBe(201);
    const lineItems = gen.body.lineItems as Array<{ description: string; level: number | null; hours: number; rate: number }>;
    expect(lineItems.length).toBe(2);
    expect(lineItems[0].description).toBe(lineItems[1].description);

    const res = await request(app)
      .get(`/api/invoices/${gen.body.id}/entries`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(true);
    // Each line item's (description, level, rate) key selects exactly its
    // own sessions, whose hours sum to the billed hours.
    for (const li of lineItems) {
      const matched = res.body.entries.filter(
        (e: { description: string; level: number | null; rate: number | null }) =>
          e.description === li.description && (e.level ?? null) === (li.level ?? null) && e.rate === li.rate,
      );
      expect(matched.length).toBe(1);
      expect(matched[0].hours).toBe(li.hours);
    }
  });

  it("returns an empty flagged result (not an error) for an invoice with no site/period", async () => {
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        invoiceNumber: `${TAG}-manual-1`,
        clientId: ctx.clientId,
        clientName: `${TAG}-client`,
        siteId: null,
        periodStart: null,
        periodEnd: null,
        subtotal: "100.00",
        totalAmount: "100.00",
        status: "draft",
        dueDate: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
        lineItems: [{ description: "Manual line", hours: 2, rate: 50, amount: 100 }],
        autoSynced: false,
      })
      .returning({ id: invoicesTable.id });

    const res = await request(app)
      .get(`/api/invoices/${inv.id}/entries`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.unresolved).toBe(true);
    expect(res.body.reason).toMatch(/no linked site/i);
    expect(res.body.entries).toEqual([]);
    expect(res.body.reconciled).toBe(false);
  });

  it("404s for a missing invoice and 403s for non-admins", async () => {
    const missing = await request(app)
      .get(`/api/invoices/${randomUUID()}/entries`)
      .set(authed(ctx.adminToken));
    expect(missing.status).toBe(404);

    const forbidden = await request(app)
      .get(`/api/invoices/${ctx.invoiceId}/entries`)
      .set(authed(ctx.employeeToken));
    expect(forbidden.status).toBe(403);
  });
});
