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
  subcontractorTimeEntriesTable,
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { lockEndedWeekInvoices, upsertWeeklyInvoice, weekStartIsoUtc } from "../lib/invoiceSync";

const TAG = `customperiodinv-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Fixed past instants — stable, no collision with live data.
// Custom period under test: 2025-06-01 .. 2025-06-30 (a "monthly" period).
const PERIOD_START = "2025-06-01";
const PERIOD_END = "2025-06-30";
const ENTRY_A_IN = new Date("2025-06-03T14:00:00.000Z"); // Tuesday, inside period
const ENTRY_A_OUT = new Date("2025-06-03T18:00:00.000Z"); // +4h
const ENTRY_OUTSIDE_IN = new Date("2025-07-10T14:00:00.000Z"); // outside period

// Independence Day 2025 falls on Friday July 4 (actual date, no observed shift).
// 14:00Z = 09:00 America/Chicago, so the clock-in date in PAYROLL_TIMEZONE is July 4.
const HOLIDAY_PERIOD_START = "2025-07-01";
const HOLIDAY_PERIOD_END = "2025-07-07";
const HOLIDAY_IN = new Date("2025-07-04T14:00:00.000Z");
const HOLIDAY_OUT = new Date("2025-07-04T18:00:00.000Z"); // +4h

type Ctx = {
  adminToken: string;
  officerId: string;
  clientId: string;
  siteId: string;
  shiftId: string;
  monthlyClientId: string;
  monthlySiteId: string;
  monthlyShiftId: string;
};
const ctx = {} as Ctx;

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
    .values({ name: `${TAG}-client`, paymentTermsDays: 14, billingCycle: "monthly" })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "1 Custom Period Ave",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: ENTRY_A_IN,
      endTime: ENTRY_A_OUT,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 2,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // Second monthly client+site+shift dedicated to the weekly-suppression test
  // so its weekly upsert can't interfere with custom-period state.
  const [mClient] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-monthly-client`, paymentTermsDays: 30, billingCycle: "monthly" })
    .returning({ id: clientsTable.id });
  ctx.monthlyClientId = mClient.id;

  const [mSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.monthlyClientId,
      name: `${TAG}-monthly-site`,
      address: "2 Custom Period Ave",
      defaultBillRate: "55.00",
    })
    .returning({ id: sitesTable.id });
  ctx.monthlySiteId = mSite.id;

  const [mShift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.monthlySiteId,
      title: `${TAG}-monthly-shift`,
      startTime: ENTRY_A_IN,
      endTime: ENTRY_A_OUT,
      payRate: "20.00",
      billRate: "45.00",
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.monthlyShiftId = mShift.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE site_id = ${ctx.siteId}::uuid OR site_id = ${ctx.monthlySiteId}::uuid`);
  await db.execute(sql`DELETE FROM subcontractor_time_entries WHERE site_id = ${ctx.siteId}::uuid OR site_id = ${ctx.monthlySiteId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid OR site_id = ${ctx.monthlySiteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid OR id = ${ctx.monthlySiteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid OR id = ${ctx.monthlyClientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE site_id = ${ctx.siteId}::uuid OR site_id = ${ctx.monthlySiteId}::uuid`);
  await db.execute(sql`DELETE FROM subcontractor_time_entries WHERE site_id = ${ctx.siteId}::uuid OR site_id = ${ctx.monthlySiteId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
});

function authed() {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

async function addApprovedEntry(clockIn: Date, clockOut: Date, hours: string, opts?: { shiftId?: string | null; siteId?: string }) {
  await db.insert(timeEntriesTable).values({
    employeeId: ctx.officerId,
    shiftId: opts?.shiftId === null ? null : (opts?.shiftId ?? ctx.shiftId),
    siteId: opts?.siteId ?? ctx.siteId,
    clockInTime: clockIn,
    clockOutTime: clockOut,
    hoursWorked: hours,
    approvalStatus: "approved",
  });
}

type LineItem = { description: string; hours: number; rate: number; amount: number };

describe("POST /invoices/generate — custom period path", () => {
  it("creates a new autoSynced=false draft with correct line items from approved entries only", async () => {
    await addApprovedEntry(ENTRY_A_IN, ENTRY_A_OUT, "4.00");
    // Pending entry in-period — must be excluded.
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      clockInTime: new Date("2025-06-05T14:00:00.000Z"),
      clockOutTime: new Date("2025-06-05T18:00:00.000Z"),
      hoursWorked: "4.00",
      approvalStatus: "pending",
    });
    // Approved entry OUTSIDE the period — must be excluded.
    await addApprovedEntry(ENTRY_OUTSIDE_IN, new Date(ENTRY_OUTSIDE_IN.getTime() + 4 * 3600_000), "4.00");

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(res.status).toBe(201);

    const [invoice] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, res.body.id));
    expect(invoice).toBeDefined();
    expect(invoice.autoSynced).toBe(false);
    expect(invoice.status).toBe("draft");
    expect(invoice.periodStart).toBe(PERIOD_START);
    expect(invoice.periodEnd).toBe(PERIOD_END);
    const lines = invoice.lineItems as LineItem[];
    expect(lines).toHaveLength(1);
    // Shift billRate 40 takes precedence over site defaultBillRate 50.
    expect(lines[0].rate).toBe(40);
    expect(lines[0].hours).toBe(4);
    expect(lines[0].amount).toBe(160);
    expect(parseFloat(String(invoice.subtotal))).toBe(160);
    expect(parseFloat(String(invoice.totalAmount))).toBe(160);
  });

  it("includes entries whose clock-in falls ON periodEnd (inclusive upper bound)", async () => {
    await addApprovedEntry(
      new Date("2025-06-30T14:00:00.000Z"),
      new Date("2025-06-30T18:00:00.000Z"),
      "4.00",
    );

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(res.status).toBe(201);
    expect(parseFloat(String(res.body.subtotal))).toBe(160);
  });

  it("applies the 1.5× federal-holiday premium as its own line item", async () => {
    // Normal 4h entry on July 3 + 4h on Independence Day (July 4, actual date).
    await addApprovedEntry(
      new Date("2025-07-03T14:00:00.000Z"),
      new Date("2025-07-03T18:00:00.000Z"),
      "4.00",
    );
    await addApprovedEntry(HOLIDAY_IN, HOLIDAY_OUT, "4.00");

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: HOLIDAY_PERIOD_START, periodEnd: HOLIDAY_PERIOD_END });
    expect(res.status).toBe(201);

    const lines = res.body.lineItems as LineItem[];
    expect(lines).toHaveLength(2);
    const holidayLine = lines.find((l) => l.description.includes("Holiday"));
    const normalLine = lines.find((l) => !l.description.includes("Holiday"));
    expect(holidayLine).toBeDefined();
    expect(normalLine).toBeDefined();
    expect(holidayLine!.description).toContain("Independence Day");
    // billRate 40 × 1.5 = 60, rounded to cents BEFORE × hours.
    expect(holidayLine!.rate).toBe(60);
    expect(holidayLine!.hours).toBe(4);
    expect(holidayLine!.amount).toBe(240);
    expect(normalLine!.rate).toBe(40);
    expect(normalLine!.amount).toBe(160);
    expect(parseFloat(String(res.body.subtotal))).toBe(400);
  });

  it("includes closed subcontractor entries at the site default bill rate", async () => {
    await addApprovedEntry(ENTRY_A_IN, ENTRY_A_OUT, "4.00");
    // Closed subcontractor entry inside the period → 3h × site rate 50 = 150.
    await db.insert(subcontractorTimeEntriesTable).values({
      siteId: ctx.siteId,
      name: `${TAG}-Sub Worker`,
      company: `${TAG}-SubCo`,
      clockInAt: new Date("2025-06-10T14:00:00.000Z"),
      clockOutAt: new Date("2025-06-10T17:00:00.000Z"),
      hoursWorked: "3.00",
    });
    // OPEN subcontractor entry (no clockOutAt) — must be excluded.
    await db.insert(subcontractorTimeEntriesTable).values({
      siteId: ctx.siteId,
      name: `${TAG}-Open Sub`,
      company: `${TAG}-SubCo`,
      clockInAt: new Date("2025-06-11T14:00:00.000Z"),
      hoursWorked: "3.00",
    });

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(res.status).toBe(201);

    const lines = res.body.lineItems as LineItem[];
    expect(lines).toHaveLength(2);
    const subLine = lines.find((l) => l.description.includes("subcontractor"));
    expect(subLine).toBeDefined();
    expect(subLine!.description).toContain(`${TAG}-Sub Worker`);
    expect(subLine!.rate).toBe(50);
    expect(subLine!.hours).toBe(3);
    expect(subLine!.amount).toBe(150);
    expect(parseFloat(String(res.body.subtotal))).toBe(310);
  });

  it("returns 400 when the period has no approved entries", async () => {
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no approved time entries/i);
  });

  it("creates a SECOND draft (no conflict) when re-generated for the same site+period", async () => {
    await addApprovedEntry(ENTRY_A_IN, ENTRY_A_OUT, "4.00");

    const first = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    const rows = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, PERIOD_START)));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.autoSynced).toBe(false);
      expect(parseFloat(String(row.subtotal))).toBe(160);
    }
  });

  it("rejects periodStart without periodEnd (and vice versa) with 400", async () => {
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/both/i);
  });

  it("rejects periodEnd earlier than periodStart with 400", async () => {
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_END, periodEnd: PERIOD_START });
    expect(res.status).toBe(400);
  });
});

describe("billingCycle suppression on the weekly path", () => {
  it("upsertWeeklyInvoice skips a monthly-billing client and creates no draft", async () => {
    // Approved entry for the monthly client's site.
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      shiftId: ctx.monthlyShiftId,
      siteId: ctx.monthlySiteId,
      clockInTime: ENTRY_A_IN,
      clockOutTime: ENTRY_A_OUT,
      hoursWorked: "4.00",
      approvalStatus: "approved",
    });

    const weekStart = weekStartIsoUtc(ENTRY_A_IN);
    const result = await upsertWeeklyInvoice(ctx.monthlySiteId, weekStart);
    expect(result.status).toBe("skipped");
    expect(result.status === "skipped" && result.reason).toBe("non_weekly_billing_cycle");

    const rows = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.siteId, ctx.monthlySiteId));
    expect(rows).toHaveLength(0);
  });

  it("the /invoices/generate weekly path returns 400 pointing at the custom-period option", async () => {
    const weekStart = weekStartIsoUtc(ENTRY_A_IN);
    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.monthlySiteId, weekStart });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/non-weekly billing cycle/i);
  });

  it("the custom-period path still works for the same monthly client", async () => {
    await db.insert(timeEntriesTable).values({
      employeeId: ctx.officerId,
      shiftId: ctx.monthlyShiftId,
      siteId: ctx.monthlySiteId,
      clockInTime: ENTRY_A_IN,
      clockOutTime: ENTRY_A_OUT,
      hoursWorked: "4.00",
      approvalStatus: "approved",
    });

    const res = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.monthlySiteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(res.status).toBe(201);
    // Shift billRate 45 × 4h = 180.
    expect(parseFloat(String(res.body.subtotal))).toBe(180);
    expect(res.body.autoSynced).toBe(false);
  });
});

describe("edited custom drafts vs re-generation (no silent tax double-charge)", () => {
  it("keeps the hand-edited draft (with its tax) intact and the re-generated draft at tax 0; neither is scheduler-syncable", async () => {
    await addApprovedEntry(ENTRY_A_IN, ENTRY_A_OUT, "4.00");

    // 1. Generate the custom draft. Always taxAmount 0, total = subtotal.
    const first = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(first.status).toBe(201);
    expect(parseFloat(String(first.body.taxAmount))).toBe(0);
    expect(parseFloat(String(first.body.totalAmount))).toBe(160);

    // 2. Admin hand-edits tax AND line items on that draft — bump the
    //    single line's amount 160 → 200 and rename it.
    const editedLines = (first.body.lineItems as LineItem[]).map((l) => ({
      ...l,
      description: `${l.description} (adjusted)`,
      amount: 200,
    }));
    const edit = await request(app)
      .put(`/api/invoices/${first.body.id}`)
      .set(authed())
      .send({ lineItems: editedLines, taxAmount: 25 });
    expect(edit.status).toBe(200);
    expect(parseFloat(String(edit.body.subtotal))).toBe(200);
    expect(parseFloat(String(edit.body.taxAmount))).toBe(25);
    expect(parseFloat(String(edit.body.totalAmount))).toBe(225);
    expect(edit.body.autoSynced).toBe(false);

    // 3. Re-generate the same site+period. Must create a SECOND draft —
    //    never update the edited one — and the new draft's tax is 0.
    const second = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(parseFloat(String(second.body.taxAmount))).toBe(0);
    // total = subtotal exactly — the edited draft's tax must NOT leak in.
    expect(parseFloat(String(second.body.totalAmount))).toBe(160);
    expect(second.body.autoSynced).toBe(false);

    // 4. Both drafts persist, both opted out of auto-sync.
    const rows = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, PERIOD_START)));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.autoSynced).toBe(false);

    // 5. The approval-driven weekly sync never touches either draft
    //    (monthly billing cycle short-circuits; autoSynced=false rows are
    //    skipped regardless). Values must be byte-identical afterwards.
    const weekStart = weekStartIsoUtc(ENTRY_A_IN);
    const syncResult = await upsertWeeklyInvoice(ctx.siteId, weekStart);
    expect(syncResult.status).toBe("skipped");
    expect(syncResult.status === "skipped" && syncResult.reason).toBe("non_weekly_billing_cycle");

    const after = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, PERIOD_START)));
    expect(after).toHaveLength(2);
    const editedAfter = after.find((r) => r.id === first.body.id)!;
    const freshAfter = after.find((r) => r.id === second.body.id)!;
    expect(parseFloat(String(editedAfter.taxAmount))).toBe(25);
    expect(parseFloat(String(editedAfter.totalAmount))).toBe(225);
    expect((editedAfter.lineItems as LineItem[])[0].description).toContain("(adjusted)");
    expect(parseFloat(String(freshAfter.taxAmount))).toBe(0);
    expect(parseFloat(String(freshAfter.totalAmount))).toBe(160);
  });

  it("lockEndedWeekInvoices stamps lockedAt on ended custom-period drafts without breaking re-generation", async () => {
    await addApprovedEntry(ENTRY_A_IN, ENTRY_A_OUT, "4.00");

    const first = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(first.status).toBe(201);

    // Period ended in 2025 → the hourly lock job must stamp lockedAt.
    await lockEndedWeekInvoices();
    const [lockedRow] = await db
      .select({ lockedAt: invoicesTable.lockedAt })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, first.body.id));
    expect(lockedRow.lockedAt).not.toBeNull();

    // Locking must not block re-generating the same period — an
    // adjustment draft is still allowed and starts unlocked with tax 0.
    const second = await request(app)
      .post("/api/invoices/generate")
      .set(authed())
      .send({ siteId: ctx.siteId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(parseFloat(String(second.body.taxAmount))).toBe(0);
    const [freshRow] = await db
      .select({ lockedAt: invoicesTable.lockedAt })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, second.body.id));
    expect(freshRow.lockedAt).toBeNull();

    // Idempotent: running the job again locks the new ended draft too
    // and leaves the first stamp in place.
    await lockEndedWeekInvoices();
    const rows = await db
      .select({ id: invoicesTable.id, lockedAt: invoicesTable.lockedAt })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, PERIOD_START)));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.lockedAt).not.toBeNull();
  });
});
