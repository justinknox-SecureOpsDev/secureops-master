import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `invgen-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  officerId: string;
  adminToken: string;
  employeeToken: string;
  clientId: string;
  // Site that has both defaultBillRate AND approved time entries.
  ratedSiteId: string;
  // Site that has approved time entries but NO defaultBillRate
  // and a shift with billRate=0 — must trigger the 400.
  unratedSiteId: string;
  ratedShiftId: string;
  unratedShiftId: string;
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

  const [ratedSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-rated-site`,
      address: "100 Rated Way",
      defaultBillRate: "42.00",
    })
    .returning({ id: sitesTable.id });
  ctx.ratedSiteId = ratedSite.id;

  const [unratedSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-unrated-site`,
      address: "200 Unrated Way",
      // defaultBillRate intentionally NULL
    })
    .returning({ id: sitesTable.id });
  ctx.unratedSiteId = unratedSite.id;

  const weekStart = new Date(`${previousMondayISO()}T00:00:00.000Z`);
  const shiftStart = new Date(weekStart.getTime() + 2 * 86400_000 + 9 * 3600_000);
  const shiftEnd = new Date(shiftStart.getTime() + 8 * 3600_000);

  // Rated shift has NO bill rate of its own (0), so invoice generation must
  // fall through to the site's defaultBillRate ($42) per the documented
  // shifts.billRate -> sites.defaultBillRate priority chain — we assert on
  // $42 below.
  const [ratedShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-rated-shift`,
      siteId: ctx.ratedSiteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "completed",
      payRate: "25.00",
      billRate: "0",
    })
    .returning({ id: shiftsTable.id });
  ctx.ratedShiftId = ratedShift.id;

  // Unrated shift: shift billRate is 0 too, so neither layer can resolve
  // a bill rate -> /invoices/generate must 400.
  const [unratedShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-unrated-shift`,
      siteId: ctx.unratedSiteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "completed",
      payRate: "25.00",
      billRate: "0",
    })
    .returning({ id: shiftsTable.id });
  ctx.unratedShiftId = unratedShift.id;

  // Approved time entries on both sites, 8h apiece.
  await db.insert(timeEntriesTable).values({
    shiftId: ctx.ratedShiftId,
    employeeId: ctx.officerId,
    siteId: ctx.ratedSiteId,
    clockInTime: shiftStart,
    clockOutTime: shiftEnd,
    hoursWorked: "8.00",
    approvalStatus: "approved",
  });
  await db.insert(timeEntriesTable).values({
    shiftId: ctx.unratedShiftId,
    employeeId: ctx.officerId,
    siteId: ctx.unratedSiteId,
    clockInTime: shiftStart,
    clockOutTime: shiftEnd,
    hoursWorked: "8.00",
    approvalStatus: "approved",
  });
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.employeeId, ctx.officerId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("POST /invoices/generate", () => {
  it("builds a draft invoice using the site's defaultBillRate when the shift has no bill rate", async () => {
    const weekStart = previousMondayISO();
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.ratedSiteId, weekStart });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe("draft");
    expect(res.body.clientId).toBe(ctx.clientId);
    expect(res.body.siteId).toBe(ctx.ratedSiteId);
    expect(Array.isArray(res.body.lineItems)).toBe(true);
    expect(res.body.lineItems.length).toBe(1);
    const line = res.body.lineItems[0];
    // Shift carries no bill rate, so the site's defaultBillRate ($42) is
    // used. 8h * $42 = $336.
    expect(line.rate).toBe(42);
    expect(line.hours).toBe(8);
    expect(line.amount).toBe(336);
    expect(parseFloat(res.body.totalAmount)).toBe(336);
  });

  it("refuses with 400 when neither the site nor the shift has a bill rate", async () => {
    const weekStart = previousMondayISO();
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.unratedSiteId, weekStart });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no bill rate on file/i);
    expect(res.body.message).toMatch(/site's default bill rate/i);
  });

  it("custom-period path warns about overlapping existing invoices", async () => {
    const weekStart = previousMondayISO();
    const periodEnd = new Date(`${weekStart}T00:00:00.000Z`);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);
    const periodEndIso = periodEnd.toISOString().slice(0, 10);

    // First custom-period invoice — the weekly draft created by the earlier
    // test already covers this range, so it should be flagged.
    const first = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.ratedSiteId, periodStart: weekStart, periodEnd: periodEndIso });
    expect(first.status).toBe(201);
    expect(Array.isArray(first.body.overlappingInvoiceIds)).toBe(true);
    expect(first.body.overlappingInvoiceIds).not.toContain(first.body.id);

    // Second custom-period invoice for the same range must flag the first.
    const second = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.ratedSiteId, periodStart: weekStart, periodEnd: periodEndIso });
    expect(second.status).toBe(201);
    expect(second.body.overlappingInvoiceIds).toContain(first.body.id);
    expect(second.body.overlappingInvoiceIds).not.toContain(second.body.id);

    // Void the first invoice — a third generate must no longer flag it.
    await db
      .execute(sql`UPDATE invoices SET status = 'void' WHERE id = ${first.body.id}::uuid`);
    const third = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.ratedSiteId, periodStart: weekStart, periodEnd: periodEndIso });
    expect(third.status).toBe(201);
    expect(third.body.overlappingInvoiceIds).not.toContain(first.body.id);
    expect(third.body.overlappingInvoiceIds).toContain(second.body.id);
  });

  it("custom-period path does not warn for a non-overlapping range", async () => {
    const weekStart = previousMondayISO();
    // Range two weeks BEFORE all existing invoices: disjoint from every
    // period created above. Seed an approved entry there so generation
    // succeeds, then assert no overlap warning is returned.
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - 14);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const entryIn = new Date(start.getTime() + 9 * 3600_000);
    const entryOut = new Date(entryIn.getTime() + 8 * 3600_000);
    await db.insert(timeEntriesTable).values({
      shiftId: ctx.ratedShiftId,
      employeeId: ctx.officerId,
      siteId: ctx.ratedSiteId,
      clockInTime: entryIn,
      clockOutTime: entryOut,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({
        siteId: ctx.ratedSiteId,
        periodStart: start.toISOString().slice(0, 10),
        periodEnd: end.toISOString().slice(0, 10),
      });
    expect(res.status).toBe(201);
    expect(res.body.overlappingInvoiceIds).toEqual([]);
  });

  it("weekly path warns when a custom-period invoice covers the same site+week", async () => {
    // Fresh site so the invoices created by earlier tests can't interfere.
    const [site] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-weekly-overlap-site`,
        address: "300 Overlap Way",
        defaultBillRate: "50.00",
      })
      .returning({ id: sitesTable.id });

    const weekStart = previousMondayISO();
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const entryIn = new Date(start.getTime() + 86400_000 + 9 * 3600_000);
    const entryOut = new Date(entryIn.getTime() + 8 * 3600_000);
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: entryIn,
      clockOutTime: entryOut,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });

    // 1) Weekly generate with NO existing custom invoice — no warning.
    const clean = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart });
    expect(clean.status).toBe(201);
    expect(clean.body.overlappingInvoiceIds).toEqual([]);

    // 2) Create a custom-period invoice overlapping the same week. Its
    //    periodStart is offset from the Monday — a custom invoice whose
    //    periodStart equals the week key would instead trip the weekly
    //    upsert's manually-edited-draft skip (separate, pre-existing guard).
    const periodStart = new Date(start);
    periodStart.setUTCDate(periodStart.getUTCDate() + 1);
    const periodEnd = new Date(start);
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 3);
    const custom = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({
        siteId: site.id,
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
      });
    expect(custom.status).toBe(201);

    // 3) Weekly generate again — must flag the custom invoice, must NOT
    //    flag itself (weekly-keyed rows for the same week are excluded).
    const flagged = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart });
    expect(flagged.status).toBe(201);
    expect(flagged.body.overlappingInvoiceIds).toContain(custom.body.id);
    expect(flagged.body.overlappingInvoiceIds).not.toContain(flagged.body.id);
    expect(flagged.body.overlappingInvoiceIds).not.toContain(clean.body.id);

    // 4) Void the custom invoice — the warning must clear.
    await db.execute(sql`UPDATE invoices SET status = 'void' WHERE id = ${custom.body.id}::uuid`);
    const cleared = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart });
    expect(cleared.status).toBe(201);
    expect(cleared.body.overlappingInvoiceIds).toEqual([]);
  });

  it("weekly path surfaces unpricedHours when ad-hoc entries can't be priced (site has no default bill rate)", async () => {
    // Site with NO defaultBillRate. One entry rides a shift that carries its
    // own billRate (priced); one is an ad-hoc clock-in with no shift (unpriced).
    // The draft must bill the priced hours AND report the dropped ones —
    // silently under-billing is exactly the bug this guards against.
    const [site] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-weekly-unpriced-site`,
        address: "400 Unpriced Way",
        // defaultBillRate intentionally NULL
      })
      .returning({ id: sitesTable.id });

    const weekStart = previousMondayISO();
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const shiftIn = new Date(start.getTime() + 86400_000 + 9 * 3600_000);
    const shiftOut = new Date(shiftIn.getTime() + 8 * 3600_000);
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-weekly-unpriced-shift`,
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

    // Priced: rides the shift's own $30 bill rate.
    await db.insert(timeEntriesTable).values({
      shiftId: shift.id,
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: shiftIn,
      clockOutTime: shiftOut,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });
    // Unpriced: ad-hoc clock-in, no shift, and the site has no default rate.
    const adhocIn = new Date(start.getTime() + 2 * 86400_000 + 9 * 3600_000);
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: adhocIn,
      clockOutTime: new Date(adhocIn.getTime() + 3.5 * 3600_000),
      hoursWorked: "3.50",
      approvalStatus: "approved",
    });

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart });
    expect(res.status).toBe(201);
    // Only the priced 8h billed: 8 × $30 = $240.
    expect(parseFloat(res.body.totalAmount)).toBe(240);
    // The dropped 3.5h are reported, not silently swallowed.
    expect(res.body.unpricedHours).toBe(3.5);

    // Re-running (update path) reports them too.
    const rerun = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart });
    expect(rerun.status).toBe(201);
    expect(rerun.body.unpricedHours).toBe(3.5);
  });

  it("weekly path omits unpricedHours when everything is priced", async () => {
    // Fresh site with a default bill rate so invoices from earlier tests
    // (some keyed to this exact week) can't interfere with the weekly upsert.
    const [site] = await db
      .insert(sitesTable)
      .values({
        clientId: ctx.clientId,
        name: `${TAG}-weekly-priced-site`,
        address: "500 Priced Way",
        defaultBillRate: "35.00",
      })
      .returning({ id: sitesTable.id });

    const weekStart = previousMondayISO();
    const start = new Date(`${weekStart}T00:00:00.000Z`);
    const entryIn = new Date(start.getTime() + 86400_000 + 9 * 3600_000);
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      siteId: site.id,
      clockInTime: entryIn,
      clockOutTime: new Date(entryIn.getTime() + 8 * 3600_000),
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: site.id, weekStart });
    expect(res.status).toBe(201);
    expect(res.body.unpricedHours).toBeUndefined();
  });

  it("blocks non-admin employees (403)", async () => {
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed(ctx.employeeToken))
      .send({ siteId: ctx.ratedSiteId, weekStart: previousMondayISO() });
    expect(res.status).toBe(403);
  });
});
