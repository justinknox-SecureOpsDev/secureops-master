import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  payrollEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// A lead is a full employee: it may read its OWN finance/banking but must
// never see another officer's. A dispatcher never sees finance/banking for
// anyone (self or other). These are security boundaries with no other
// automated coverage, so this suite pins them.
const TAG = `lead-finance-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  leadId: string;
  officerId: string;
  dispatcherId: string;
  leadToken: string;
  dispatcherToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeEmployeeRow(userId: string, suffix: string): Promise<void> {
  await db.insert(employeesTable).values({
    userId,
    position: "officer",
    hourlyRate: "37.50",
    bankAccountName: `${TAG} ${suffix}`,
    bankAccountNumber: `00${suffix}11223344`,
    bankBsb: "123456",
    taxCode: "1099",
    skills: [],
  });
}

beforeAll(async () => {
  ctx.leadId = await makeUser("lead", "lead");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatch");

  await makeEmployeeRow(ctx.leadId, "lead");
  await makeEmployeeRow(ctx.officerId, "officer");
  await makeEmployeeRow(ctx.dispatcherId, "dispatch");

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      payRate: "30.00",
      billRate: "55.00",
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // One payroll row for the lead (must be returned) and one for the other
  // officer (must NEVER appear in the lead's /me/payroll response).
  const periodStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const periodEnd = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await db.insert(payrollEntriesTable).values([
    {
      employeeId: ctx.leadId,
      siteId: ctx.siteId,
      periodStart,
      periodEnd,
      totalHours: "40.00",
      hourlyRate: "37.50",
      grossPay: "1500.00",
      netPay: "1500.00",
      status: "paid",
    },
    {
      employeeId: ctx.officerId,
      siteId: ctx.siteId,
      periodStart,
      periodEnd,
      totalHours: "40.00",
      hourlyRate: "37.50",
      grossPay: "1500.00",
      netPay: "1500.00",
      status: "paid",
    },
  ]);

  ctx.leadToken = signToken({
    userId: ctx.leadId,
    email: `${TAG}-lead@example.test`,
    role: "lead",
  });
  ctx.dispatcherToken = signToken({
    userId: ctx.dispatcherId,
    email: `${TAG}-dispatch@example.test`,
    role: "dispatcher",
  });
});

afterAll(async () => {
  const ids = [ctx.leadId, ctx.officerId, ctx.dispatcherId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
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

describe("GET /employees/:id — lead self vs other finance boundary", () => {
  it("returns the FULL record (rate + banking) when a lead reads their OWN id", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.leadId}`)
      .set(authed(ctx.leadToken));
    expect(res.status).toBe(200);
    // Own finance is visible to a lead — they are a full employee.
    expect(res.body.hourlyRate).toBe("37.50");
    expect(res.body.bankAccountNumber).toBe("00lead11223344");
    expect(res.body.bankAccountName).toBe(`${TAG} lead`);
    expect(res.body.bankBsb).toBe("123456");
    expect(res.body.taxCode).toBe("1099");
  });

  it("returns the STRIPPED projection when a lead reads ANOTHER officer's id", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.leadToken));
    expect(res.status).toBe(200);
    // Identity/operational fields stay, finance/banking are gone.
    expect(res.body.id).toBe(ctx.officerId);
    expect(res.body).not.toHaveProperty("hourlyRate");
    expect(res.body).not.toHaveProperty("bankAccountNumber");
    expect(res.body).not.toHaveProperty("bankAccountName");
    expect(res.body).not.toHaveProperty("bankBsb");
    expect(res.body).not.toHaveProperty("taxCode");
  });

  it("keeps a dispatcher stripped BOTH ways (self and other)", async () => {
    const ownRes = await request(app)
      .get(`/api/employees/${ctx.dispatcherId}`)
      .set(authed(ctx.dispatcherToken));
    expect(ownRes.status).toBe(200);
    expect(ownRes.body).not.toHaveProperty("hourlyRate");
    expect(ownRes.body).not.toHaveProperty("bankAccountNumber");

    const otherRes = await request(app)
      .get(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.dispatcherToken));
    expect(otherRes.status).toBe(200);
    expect(otherRes.body).not.toHaveProperty("hourlyRate");
    expect(otherRes.body).not.toHaveProperty("bankAccountNumber");
  });
});

describe("GET /shifts — lead finance stripping", () => {
  it("strips payRate/billRate from shifts for a lead", async () => {
    const res = await request(app)
      .get("/api/shifts")
      .set(authed(ctx.leadToken));
    expect(res.status).toBe(200);
    const shift = (res.body as Array<Record<string, unknown>>).find((s) => s.id === ctx.shiftId);
    expect(shift).toBeTruthy();
    expect(shift).not.toHaveProperty("payRate");
    expect(shift).not.toHaveProperty("billRate");
    expect(shift).not.toHaveProperty("hourlyRate");
    expect(shift).not.toHaveProperty("billableRate");
  });
});

describe("GET /me/payroll — lead reads only their own rows", () => {
  it("returns the lead's own payroll rows and never another officer's", async () => {
    const res = await request(app)
      .get("/api/me/payroll")
      .set(authed(ctx.leadToken));
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    // Every returned row belongs to the lead (employeeId pinned to caller).
    for (const r of rows) {
      expect(r.siteId).toBe(ctx.siteId);
    }
    // The lead has exactly one payroll row in this fixture; the other
    // officer's identical row must not leak in.
    expect(rows.length).toBe(1);
    expect(res.body.summary.count).toBe(1);
  });
});
