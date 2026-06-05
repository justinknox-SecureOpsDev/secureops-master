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
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { upsertWeeklyInvoice } from "../lib/invoiceSync";

// Federal-holiday pay (1.5×) applied to BOTH officer payroll and client
// billing. We pin the fixture to a real, closed holiday week so the
// calendar logic exercises a genuine federal holiday:
//   Christmas 2025 (Thu Dec 25) — week starts Mon Dec 22, 2025.
// One entry lands on the holiday (premium) and one on an ordinary day in
// the same week (base rate), proving the holiday hours are split out and
// uplifted while normal hours stay at the base rate.
const TAG = `holpay-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const WEEK_START = "2025-12-22"; // Monday
const HOLIDAY_CLOCK_IN = new Date("2025-12-25T15:00:00Z"); // 9am CST, Christmas
const REGULAR_CLOCK_IN = new Date("2025-12-23T15:00:00Z"); // 9am CST, Tuesday
const PAY_RATE = 30; // officer $/hr
const BILL_RATE = 50; // client $/hr
const HOURS = 8;

const ODD_RATE = 10.01; // odd-cent base → 1.5× = 15.015, must round to 15.02
const ODD_HOURS = 5;

type Ctx = {
  adminId: string;
  employeeId: string;
  oddEmployeeId: string;
  adminToken: string;
  clientId: string;
  siteId: string;
  oddSiteId: string;
  shiftId: string;
  oddShiftId: string;
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
  ctx.adminId = admin.id;
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });

  const [emp] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-officer@example.test`,
      passwordHash,
      firstName: "Nina",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.employeeId = emp.id;

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
      address: "1 Holiday Way",
      defaultBillRate: String(BILL_RATE),
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: HOLIDAY_CLOCK_IN,
      endTime: new Date(HOLIDAY_CLOCK_IN.getTime() + HOURS * 3600_000),
      requiredLicenseLevel: 2,
      headcount: 5,
      status: "completed",
      payRate: String(PAY_RATE),
      billRate: String(BILL_RATE),
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  for (const clockIn of [HOLIDAY_CLOCK_IN, REGULAR_CLOCK_IN]) {
    await db.insert(timeEntriesTable).values({
      shiftId: ctx.shiftId,
      employeeId: ctx.employeeId,
      siteId: ctx.siteId,
      clockInTime: clockIn,
      clockOutTime: new Date(clockIn.getTime() + HOURS * 3600_000),
      hoursWorked: String(HOURS.toFixed(2)),
      approvalStatus: "approved",
    });
  }

  // Odd-cent reconciliation fixture: separate employee + site so it can't
  // collide with the payroll entry / invoice above. One holiday entry at an
  // odd-cent rate where rate × 1.5 needs cent-rounding (10.01 → 15.02).
  const [oddEmp] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-odd@example.test`,
      passwordHash,
      firstName: "Otto",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.oddEmployeeId = oddEmp.id;

  const [oddSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-odd-site`,
      address: "2 Holiday Way",
      defaultBillRate: String(ODD_RATE),
    })
    .returning({ id: sitesTable.id });
  ctx.oddSiteId = oddSite.id;

  const [oddShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-odd-shift`,
      siteId: ctx.oddSiteId,
      startTime: HOLIDAY_CLOCK_IN,
      endTime: new Date(HOLIDAY_CLOCK_IN.getTime() + ODD_HOURS * 3600_000),
      requiredLicenseLevel: 2,
      headcount: 5,
      status: "completed",
      payRate: String(ODD_RATE),
      billRate: String(ODD_RATE),
    })
    .returning({ id: shiftsTable.id });
  ctx.oddShiftId = oddShift.id;

  await db.insert(timeEntriesTable).values({
    shiftId: ctx.oddShiftId,
    employeeId: ctx.oddEmployeeId,
    siteId: ctx.oddSiteId,
    clockInTime: HOLIDAY_CLOCK_IN,
    clockOutTime: new Date(HOLIDAY_CLOCK_IN.getTime() + ODD_HOURS * 3600_000),
    hoursWorked: String(ODD_HOURS.toFixed(2)),
    approvalStatus: "approved",
  });
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM payroll_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`,
  );
  await db.execute(
    sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`,
  );
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("federal-holiday premium pay", () => {
  it("pays officers 1.5× for hours clocked on a federal holiday", async () => {
    const res = await request(app)
      .post("/api/payroll/generate")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ siteId: ctx.siteId, weekStart: WEEK_START });
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    const row = res.body[0];
    expect(Number(row.totalHours)).toBe(HOURS * 2);
    // 8h regular @ $30 = $240; 8h holiday @ $45 (30×1.5) = $360 → $600.
    const expectedGross = HOURS * PAY_RATE + HOURS * PAY_RATE * 1.5;
    expect(Number(row.grossPay)).toBe(expectedGross);
  });

  it("bills the client 1.5× for holiday hours as a separate line item", async () => {
    const result = await upsertWeeklyInvoice(ctx.siteId, WEEK_START);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    // Two lines: regular (8×$50=$400) + holiday (8×$75=$600) = $1000.
    expect(result.lineCount).toBe(2);
    const expectedTotal = HOURS * BILL_RATE + HOURS * BILL_RATE * 1.5;
    expect(result.totalAmount).toBe(expectedTotal);

    const [inv] = await db
      .select({ lineItems: invoicesTable.lineItems })
      .from(invoicesTable)
      .where(sql`${invoicesTable.id} = ${result.invoiceId}::uuid`);
    const lines = (inv?.lineItems ?? []) as Array<{
      description: string;
      hours: number;
      rate: number;
      amount: number;
    }>;
    const holidayLine = lines.find((l) => /— Holiday \(/.test(l.description));
    expect(holidayLine).toBeDefined();
    expect(holidayLine?.rate).toBe(BILL_RATE * 1.5);
    expect(holidayLine?.description).toMatch(/Christmas Day, 1\.5×/);
    const regularLine = lines.find((l) => !/— Holiday \(/.test(l.description));
    expect(regularLine?.rate).toBe(BILL_RATE);
  });

  it("rounds the holiday premium rate to cents so rate × hours reconciles (odd-cent base)", async () => {
    const roundedRate = Math.round(ODD_RATE * 1.5 * 100) / 100; // 15.02
    expect(roundedRate).toBe(15.02);

    // Payroll: gross uses the same cent-rounded rate.
    const res = await request(app)
      .post("/api/payroll/generate")
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ siteId: ctx.oddSiteId, weekStart: WEEK_START });
    expect(res.status).toBe(201);
    expect(res.body.length).toBe(1);
    expect(Number(res.body[0].grossPay)).toBe(roundedRate * ODD_HOURS); // 75.10

    // Invoice: holiday line's amount equals rate × hours exactly (no drift).
    const result = await upsertWeeklyInvoice(ctx.oddSiteId, WEEK_START);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const [inv] = await db
      .select({ lineItems: invoicesTable.lineItems })
      .from(invoicesTable)
      .where(sql`${invoicesTable.id} = ${result.invoiceId}::uuid`);
    const line = ((inv?.lineItems ?? []) as Array<{
      description: string;
      hours: number;
      rate: number;
      amount: number;
    }>).find((l) => /— Holiday \(/.test(l.description));
    expect(line).toBeDefined();
    expect(line?.rate).toBe(roundedRate);
    expect(line?.amount).toBe(roundedRate * ODD_HOURS);
    expect(Math.round(line!.rate * line!.hours * 100) / 100).toBe(line!.amount);
  });
});
