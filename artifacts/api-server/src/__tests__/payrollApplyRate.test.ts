import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, inArray } from "drizzle-orm";
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

const TAG = `applyrate-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  officerId: string;
  adminToken: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
  // Three time entries spanning the same (employee, site, week):
  //   zeroRateEntryId — no override / no shift / no employee rate (current
  //     effective rate = $0). The target of the happy-path update.
  //   alreadyRatedEntryId — shift.payRate=$20 already, so onlyZeroRate
  //     (default) must skip it.
  //   processedEntryId — its weekly payroll_entry bucket is already in
  //     status="processed", so any apply must refuse.
  zeroRateEntryId: string;
  alreadyRatedEntryId: string;
  processedEntryId: string;
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

  // Officer needs an employees row but with NO hourlyRate so the
  // zero-rate entry truly resolves to $0.
  await db.insert(employeesTable).values({
    userId: ctx.officerId,
    directDepositConsent: false,
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "100 Apply Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const periodStart = previousMondayISO();
  const periodStartDate = new Date(`${periodStart}T00:00:00.000Z`);
  const shiftStart = new Date(periodStartDate.getTime() + 2 * 86400_000 + 9 * 3600_000);
  const shiftEnd = new Date(shiftStart.getTime() + 4 * 3600_000);

  // Shift with NO payRate (NULL) — so its associated time entry has no
  // shift-rate fallback. Combined with the officer's null hourlyRate this
  // is a true "$0 effective" entry.
  const [zeroShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-zero-shift`,
      siteId: ctx.siteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "completed",
    })
    .returning({ id: shiftsTable.id });

  // Shift WITH a payRate so its time entry is already rated.
  const [ratedShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-rated-shift`,
      siteId: ctx.siteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "completed",
      payRate: "20.00",
    })
    .returning({ id: shiftsTable.id });

  const [zeroEntry] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: zeroShift.id,
      employeeId: ctx.officerId,
      siteId: ctx.siteId,
      clockInTime: shiftStart,
      clockOutTime: shiftEnd,
      hoursWorked: "4.00",
      approvalStatus: "approved",
    })
    .returning({ id: timeEntriesTable.id });
  ctx.zeroRateEntryId = zeroEntry.id;

  const [ratedEntry] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ratedShift.id,
      employeeId: ctx.officerId,
      siteId: ctx.siteId,
      clockInTime: shiftStart,
      clockOutTime: shiftEnd,
      hoursWorked: "4.00",
      approvalStatus: "approved",
    })
    .returning({ id: timeEntriesTable.id });
  ctx.alreadyRatedEntryId = ratedEntry.id;

  // Third entry whose weekly bucket is already "processed" — the route
  // must skip it even if its current rate is $0. Use a DIFFERENT week
  // (one week earlier) so its bucket lock doesn't bleed onto the other
  // two entries' current-week bucket.
  const prevWeekStartDate = new Date(periodStartDate.getTime() - 7 * 86400_000);
  const prevWeekStart = prevWeekStartDate.toISOString().slice(0, 10);
  const prevShiftStart = new Date(prevWeekStartDate.getTime() + 2 * 86400_000 + 9 * 3600_000);
  const prevShiftEnd = new Date(prevShiftStart.getTime() + 4 * 3600_000);
  const [processedShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-processed-shift`,
      siteId: ctx.siteId,
      startTime: prevShiftStart,
      endTime: prevShiftEnd,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "completed",
    })
    .returning({ id: shiftsTable.id });
  const [processedEntry] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: processedShift.id,
      employeeId: ctx.officerId,
      siteId: ctx.siteId,
      clockInTime: prevShiftStart,
      clockOutTime: prevShiftEnd,
      hoursWorked: "4.00",
      approvalStatus: "approved",
    })
    .returning({ id: timeEntriesTable.id });
  ctx.processedEntryId = processedEntry.id;

  // The apply-rate route looks for a payroll_entries row keyed by
  // (employeeId, siteId, periodStart=monday). Stamp one in "processed"
  // for the PREVIOUS week so only the processed entry's bucket is locked.
  await db.insert(payrollEntriesTable).values({
    employeeId: ctx.officerId,
    siteId: ctx.siteId,
    periodStart: prevWeekStart,
    periodEnd: new Date(prevWeekStartDate.getTime() + 6 * 86400_000).toISOString().slice(0, 10),
    totalHours: "4.00",
    hourlyRate: "25.00",
    grossPay: "100.00",
    netPay: "100.00",
    status: "processed",
  });
  // Reference unused periodStart to satisfy the linter.
  void periodStart;
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.employeeId, ctx.officerId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("POST /payroll/board/apply-rate", () => {
  it("updates the zero-rate entry, skips the already-rated one, and refuses the already-processed bucket", async () => {
    const ids = [ctx.zeroRateEntryId, ctx.alreadyRatedEntryId, ctx.processedEntryId];
    const res = await request(app)
      .post("/api/payroll/board/apply-rate")
      .set(authed(ctx.adminToken))
      .send({ timeEntryIds: ids, rate: 27.5 });

    expect(res.status).toBe(200);
    expect(res.body.rate).toBe(27.5);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.skippedCount).toBe(2);

    type Skip = { id: string; reason: string };
    const skipped: Skip[] = res.body.skipped;
    const processedSkip = skipped.find((s) => s.id === ctx.processedEntryId);
    const ratedSkip = skipped.find((s) => s.id === ctx.alreadyRatedEntryId);
    expect(processedSkip?.reason).toMatch(/already processed|already paid/i);
    expect(ratedSkip?.reason).toMatch(/non-zero rate/i);

    // The zero-rate entry's pay_rate_override is now $27.50.
    const [zeroAfter] = await db
      .select({ override: timeEntriesTable.payRateOverride })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, ctx.zeroRateEntryId));
    expect(parseFloat(String(zeroAfter.override))).toBe(27.5);

    // The other two are untouched.
    const others = await db
      .select({ id: timeEntriesTable.id, override: timeEntriesTable.payRateOverride })
      .from(timeEntriesTable)
      .where(inArray(timeEntriesTable.id, [ctx.alreadyRatedEntryId, ctx.processedEntryId]));
    for (const r of others) expect(r.override).toBeNull();
  });

  it("blocks non-admin employees (403)", async () => {
    const res = await request(app)
      .post("/api/payroll/board/apply-rate")
      .set(authed(ctx.employeeToken))
      .send({ timeEntryIds: [ctx.zeroRateEntryId], rate: 30 });
    expect(res.status).toBe(403);
  });
});
