/**
 * Invoices bucket by the SAME business-TZ (Central) week as payroll and the
 * officer time card. This guards the Sunday-evening-Central boundary sliver:
 * a shift clocked in on Sunday evening Central is already Monday in UTC, so a
 * naive UTC-Monday bucket would bill it a full week LATER than payroll pays it.
 * After the alignment, both land in the same week (the one that ENDS on that
 * Sunday).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
import bcrypt from "bcryptjs";
import { upsertWeeklyInvoice, weekStartIsoBusiness } from "../lib/invoiceSync";
import { businessTimeZone, startOfBusinessWeek, businessDateIso } from "../lib/businessTime";

const TAG = `invtz-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Sunday 2026-06-14 20:00 America/Chicago (CDT, UTC-5) == 2026-06-15 01:00Z.
// The instant is already MONDAY in UTC, but SUNDAY in Central. Neither the
// Central week nor the UTC week around it contains a US federal holiday.
const SLIVER_IN = new Date("2026-06-15T01:00:00.000Z");
const SLIVER_OUT = new Date("2026-06-15T05:00:00.000Z"); // +4h, still Central Sunday
// Business (Central) Monday of the week CONTAINING that Sunday.
const BUSINESS_WEEK = "2026-06-08";
// What a naive UTC-Monday bucket would have produced — a week LATER.
const UTC_WEEK = "2026-06-15";

type Ctx = { officerId: string; clientId: string; siteId: string; shiftId: string };
const ctx = {} as Ctx;

beforeAll(async () => {
  const [officer] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-officer@example.test`,
      passwordHash,
      firstName: "Sliver",
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
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Sliver Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: SLIVER_IN,
      endTime: SLIVER_OUT,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  await db.insert(timeEntriesTable).values({
    shiftId: ctx.shiftId,
    siteId: ctx.siteId,
    employeeId: ctx.officerId,
    clockInTime: SLIVER_IN,
    clockOutTime: SLIVER_OUT,
    hoursWorked: "4.00",
    approvalStatus: "approved",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("invoice week bucketing — Sunday-night Central boundary sliver", () => {
  it("keys the sliver to the business (Central) week, not the UTC week", () => {
    const week = weekStartIsoBusiness(SLIVER_IN);
    expect(week).toBe(BUSINESS_WEEK);
    // Prove the drift the alignment removes: the naive UTC bucket is a week off.
    expect(week).not.toBe(UTC_WEEK);
  });

  it("matches the payroll week bucket for the same clock-in", () => {
    const tz = businessTimeZone();
    const payrollWeek = businessDateIso(startOfBusinessWeek(SLIVER_IN, tz), tz);
    expect(weekStartIsoBusiness(SLIVER_IN)).toBe(payrollWeek);
  });

  it("bills the sliver hours into the week that ENDS on that Sunday", async () => {
    const week = weekStartIsoBusiness(SLIVER_IN);
    const result = await upsertWeeklyInvoice(ctx.siteId, week);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    // 4h @ shift billRate 40 = 160.
    expect(result.totalAmount).toBe(160);

    const [inv] = await db
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, week)));
    expect(inv).toBeDefined();
    expect(inv!.periodStart).toBe(BUSINESS_WEEK);
    // periodEnd is the Sunday that closes the business week — the very day of
    // the sliver, so it bills in the same week payroll pays it.
    expect(inv!.periodEnd).toBe("2026-06-14");
  });
});
