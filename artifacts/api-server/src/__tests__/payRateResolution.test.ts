import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  payrollEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { resolvePayRate } from "../lib/payRate";
import { upsertWeeklyInvoice } from "../lib/invoiceSync";

// Employee-profile pay rate wins: override > profile hourlyRate > shift rate,
// where null AND zero both mean "not set". Covers the Payroll Board buckets,
// weekly /payroll/generate, the holiday premium on the resolved rate, the
// processed-row guard, and that client invoices are untouched.
const TAG = `raterez-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const SHIFT_RATE = 18;
const PROFILE_RATE = 22;
const PROFILE_RATE_B = 31.5;
const OVERRIDE_RATE = 40;
const BILL_RATE = 50;
const HOURS = 8;

type Ctx = {
  adminId: string;
  adminToken: string;
  profOfficerId: string; // profile $22
  profOfficerBId: string; // profile $31.50 (same shift as A)
  blankOfficerId: string; // no employees.hourlyRate
  zeroOfficerId: string; // hourlyRate = "0.00"
  overrideOfficerId: string; // profile $22 + per-entry override $40
  processedOfficerId: string; // profile $22, week already processed
  clientId: string;
  siteId: string;
  shiftId: string;
  overrideEntryId: string;
  processedPayrollId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
      // Payroll pay-run preview/export is company-owner gated (Task #733).
      isCompanyOwner: role === "admin",
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
const WEEK_START = previousMondayISO();

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.profOfficerId = await makeUser("employee", "prof");
  ctx.profOfficerBId = await makeUser("employee", "profb");
  ctx.blankOfficerId = await makeUser("employee", "blank");
  ctx.zeroOfficerId = await makeUser("employee", "zero");
  ctx.overrideOfficerId = await makeUser("employee", "ovr");
  ctx.processedOfficerId = await makeUser("employee", "proc");

  await db.insert(employeesTable).values([
    { userId: ctx.profOfficerId, hourlyRate: String(PROFILE_RATE) },
    { userId: ctx.profOfficerBId, hourlyRate: String(PROFILE_RATE_B) },
    { userId: ctx.blankOfficerId }, // hourlyRate null
    { userId: ctx.zeroOfficerId, hourlyRate: "0.00" },
    { userId: ctx.overrideOfficerId, hourlyRate: String(PROFILE_RATE) },
    { userId: ctx.processedOfficerId, hourlyRate: String(PROFILE_RATE) },
  ]);

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, contactEmail: `${TAG}-client@example.test` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Rate Rd" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const periodStart = new Date(`${WEEK_START}T00:00:00.000Z`);
  const shiftStart = new Date(periodStart.getTime() + 2 * 24 * 3600_000 + 15 * 3600_000); // Wed 15:00Z
  const shiftEnd = new Date(shiftStart.getTime() + HOURS * 3600_000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 6,
      status: "completed",
      payRate: String(SHIFT_RATE),
      billRate: String(BILL_RATE),
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  const mkEntry = (employeeId: string, extra: Record<string, unknown> = {}) => ({
    shiftId: ctx.shiftId,
    employeeId,
    siteId: ctx.siteId,
    clockInTime: shiftStart,
    clockOutTime: shiftEnd,
    hoursWorked: String(HOURS),
    approvalStatus: "approved" as const,
    ...extra,
  });
  await db.insert(timeEntriesTable).values([
    mkEntry(ctx.profOfficerId),
    mkEntry(ctx.profOfficerBId),
    mkEntry(ctx.blankOfficerId),
    mkEntry(ctx.zeroOfficerId),
    mkEntry(ctx.processedOfficerId),
  ]);
  const [ovrEntry] = await db
    .insert(timeEntriesTable)
    .values(mkEntry(ctx.overrideOfficerId, { payRateOverride: String(OVERRIDE_RATE) }))
    .returning({ id: timeEntriesTable.id });
  ctx.overrideEntryId = ovrEntry.id;

  // Pre-existing processed payroll row for processedOfficer's week — the
  // generate endpoint must leave it untouched.
  const [pe] = await db
    .insert(payrollEntriesTable)
    .values({
      employeeId: ctx.processedOfficerId,
      siteId: ctx.siteId,
      periodStart: WEEK_START,
      periodEnd: new Date(new Date(`${WEEK_START}T00:00:00Z`).getTime() + 6 * 86400_000).toISOString().slice(0, 10),
      totalHours: "1.00",
      hourlyRate: "5.00",
      grossPay: "5.00",
      tax: "0",
      netPay: "5.00",
      status: "processed",
    })
    .returning({ id: payrollEntriesTable.id });
  ctx.processedPayrollId = pe.id;
});

afterAll(async () => {
  const ids = [
    ctx.adminId, ctx.profOfficerId, ctx.profOfficerBId, ctx.blankOfficerId,
    ctx.zeroOfficerId, ctx.overrideOfficerId, ctx.processedOfficerId,
  ].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

const authed = { get Authorization() { return `Bearer ${ctx.adminToken}`; } };

describe("resolvePayRate (unit)", () => {
  it("applies override > profile > shift with zero/null = not set", () => {
    expect(resolvePayRate({ overrideRate: "40", profileRate: "22", shiftRate: "18" }))
      .toMatchObject({ baseRate: 40, source: "override" });
    expect(resolvePayRate({ profileRate: "22", shiftRate: "18" }))
      .toMatchObject({ baseRate: 22, source: "profile" });
    expect(resolvePayRate({ profileRate: null, shiftRate: "18" }))
      .toMatchObject({ baseRate: 18, source: "shift" });
    expect(resolvePayRate({ profileRate: "0.00", shiftRate: "18" }))
      .toMatchObject({ baseRate: 18, source: "shift" });
    // Shift rate 0.00 must NOT beat a real profile rate (the ?? trap).
    expect(resolvePayRate({ profileRate: "22", shiftRate: "0.00" }))
      .toMatchObject({ baseRate: 22, source: "profile" });
    expect(resolvePayRate({ profileRate: "0.00", shiftRate: "0.00" }))
      .toMatchObject({ baseRate: 0, source: "none" });
  });

  it("rounds the holiday premium rate to cents BEFORE multiplying", () => {
    // Christmas 2025, 9am CST. $10.01 × 1.5 = 15.015 → must round to 15.02.
    const r = resolvePayRate({ profileRate: "10.01", clockInTime: new Date("2025-12-25T15:00:00Z") });
    expect(r.holidayName).toBeTruthy();
    expect(r.effectiveRate).toBe(15.02);
    expect(r.source).toBe("profile");
    // Non-holiday: no premium.
    const n = resolvePayRate({ profileRate: "10.01", clockInTime: new Date("2025-12-23T15:00:00Z") });
    expect(n.effectiveRate).toBe(10.01);
  });
});

describe("Payroll Board rate resolution", () => {
  it("uses profile > shift, exposes rateSource, and pays two officers on one shift differently", async () => {
    const res = await request(app)
      .get(`/api/payroll/board?statusFilter=all&siteId=${ctx.siteId}`)
      .set(authed);
    expect(res.status).toBe(200);
    const groups = (Array.isArray(res.body) ? res.body : res.body.groups ?? []) as Array<{ buckets: any[] }>;
    const buckets = groups.flatMap((g) => g.buckets);
    const bucketOf = (empId: string) => buckets.find((b) => b.employeeId === empId);

    const prof = bucketOf(ctx.profOfficerId);
    expect(prof.grossPay).toBe(HOURS * PROFILE_RATE);
    expect(prof.entries[0].rate).toBe(PROFILE_RATE);
    expect(prof.entries[0].rateSource).toBe("profile");

    // Two officers, same shift, different profile rates → different gross.
    const profB = bucketOf(ctx.profOfficerBId);
    expect(profB.grossPay).toBe(HOURS * PROFILE_RATE_B);
    expect(profB.grossPay).not.toBe(prof.grossPay);

    // Blank and 0.00 profile rates fall back to the shift rate.
    for (const id of [ctx.blankOfficerId, ctx.zeroOfficerId]) {
      const b = bucketOf(id);
      expect(b.grossPay).toBe(HOURS * SHIFT_RATE);
      expect(b.entries[0].rateSource).toBe("shift");
    }

    // Per-entry override still beats the profile rate.
    const ovr = bucketOf(ctx.overrideOfficerId);
    expect(ovr.grossPay).toBe(HOURS * OVERRIDE_RATE);
    expect(ovr.entries[0].rateSource).toBe("override");
  });

  it("apply-rate onlyZeroRate treats a profile-rated entry as already priced", async () => {
    const res = await request(app)
      .post("/api/payroll/board/apply-rate")
      .set(authed)
      .send({ timeEntryIds: [ctx.overrideEntryId], rate: 99, onlyZeroRate: true });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount ?? 0).toBe(0);
    // Override untouched.
    const [row] = await db
      .select({ o: timeEntriesTable.payRateOverride })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, ctx.overrideEntryId));
    expect(Number(row.o)).toBe(OVERRIDE_RATE);
  });
});

describe("weekly /payroll/generate rate resolution", () => {
  it("pays profile rates over shift rates, keeps fallbacks, and skips processed rows", async () => {
    const res = await request(app)
      .post("/api/payroll/generate")
      .set(authed)
      .send({ siteId: ctx.siteId, weekStart: WEEK_START });
    expect(res.status).toBe(201);
    const byEmp = new Map((res.body as any[]).map((r) => [r.employeeId, r]));

    expect(Number(byEmp.get(ctx.profOfficerId)?.grossPay)).toBe(HOURS * PROFILE_RATE);
    expect(Number(byEmp.get(ctx.profOfficerBId)?.grossPay)).toBe(HOURS * PROFILE_RATE_B);
    expect(Number(byEmp.get(ctx.blankOfficerId)?.grossPay)).toBe(HOURS * SHIFT_RATE);
    expect(Number(byEmp.get(ctx.zeroOfficerId)?.grossPay)).toBe(HOURS * SHIFT_RATE);
    expect(Number(byEmp.get(ctx.overrideOfficerId)?.grossPay)).toBe(HOURS * OVERRIDE_RATE);
    // 1099: no withholding.
    for (const r of byEmp.values()) expect(Number(r.tax)).toBe(0);

    // The already-processed row was not rewritten and not returned.
    expect(byEmp.has(ctx.processedOfficerId)).toBe(false);
    const [pe] = await db
      .select({ gross: payrollEntriesTable.grossPay, status: payrollEntriesTable.status })
      .from(payrollEntriesTable)
      .where(eq(payrollEntriesTable.id, ctx.processedPayrollId));
    expect(pe.status).toBe("processed");
    expect(Number(pe.gross)).toBe(5);
  });
});

describe("client billing is untouched", () => {
  it("invoices still price from bill rates only, ignoring profile pay rates", async () => {
    const result = await upsertWeeklyInvoice(ctx.siteId, WEEK_START);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    // 6 entries × 8h × $50 bill rate — profile/override pay rates must not
    // move the client-side total by a cent.
    expect(result.totalAmount).toBe(6 * HOURS * BILL_RATE);
  });
});
