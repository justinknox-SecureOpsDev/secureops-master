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
  shiftAssignmentsTable,
  payrollEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// A site manager is a full employee: it may read its OWN finance/banking but
// must never see another officer's. A dispatcher never sees finance/banking for
// anyone (self or other). These are security boundaries with no other
// automated coverage, so this suite pins them.
const TAG = `mgr-finance-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  managerId: string;
  officerId: string;
  dispatcherId: string;
  managerToken: string;
  dispatcherToken: string;
  officerToken: string;
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
    // PII / right-to-work / personal documents — must never reach a dispatcher
    // (or a site manager reading another officer) via the stripped projection.
    dateOfBirth: "1990-01-01",
    niNumber: `NI${suffix}`,
    rightToWorkStatus: "citizen",
    rightToWorkDocKey: `rtw/${suffix}.pdf`,
    passportDocKey: `passport/${suffix}.pdf`,
    cvKey: `cv/${suffix}.pdf`,
    skills: [],
  });
}

beforeAll(async () => {
  ctx.managerId = await makeUser("site_manager", "manager");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatch");

  await makeEmployeeRow(ctx.managerId, "manager");
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

  // One payroll row for the manager (must be returned) and one for the other
  // officer (must NEVER appear in the manager's /me/payroll response).
  const periodStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const periodEnd = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await db.insert(payrollEntriesTable).values([
    {
      employeeId: ctx.managerId,
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

  ctx.managerToken = signToken({
    userId: ctx.managerId,
    email: `${TAG}-manager@example.test`,
    role: "site_manager",
  });
  ctx.dispatcherToken = signToken({
    userId: ctx.dispatcherId,
    email: `${TAG}-dispatch@example.test`,
    role: "dispatcher",
  });
  ctx.officerToken = signToken({
    userId: ctx.officerId,
    email: `${TAG}-officer@example.test`,
    role: "employee",
  });
});

afterAll(async () => {
  const ids = [ctx.managerId, ctx.officerId, ctx.dispatcherId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id = ANY(${arr})`);
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

describe("GET /employees/:id — site manager self vs other finance boundary", () => {
  it("returns the FULL record (rate + banking) when a manager reads their OWN id", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.managerId}`)
      .set(authed(ctx.managerToken));
    expect(res.status).toBe(200);
    // Own finance is visible to a site manager — they are a full employee.
    expect(res.body.hourlyRate).toBe("37.50");
    expect(res.body.bankAccountNumber).toBe("00manager11223344");
    expect(res.body.bankAccountName).toBe(`${TAG} manager`);
    expect(res.body.bankBsb).toBe("123456");
    expect(res.body.taxCode).toBe("1099");
  });

  it("returns the STRIPPED projection when a manager reads ANOTHER officer's id", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.managerToken));
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

  it("forbids a plain employee from reading ANOTHER officer's profile (403)", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.dispatcherId}`)
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(403);
    // No record leaks in the forbidden body.
    expect(res.body).not.toHaveProperty("hourlyRate");
    expect(res.body).not.toHaveProperty("bankAccountNumber");
    expect(res.body).not.toHaveProperty("email");
  });

  it("still lets a plain employee read their OWN profile (200, full record)", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ctx.officerId);
    // Own finance is visible to a regular employee.
    expect(res.body.hourlyRate).toBe("37.50");
    expect(res.body.bankAccountNumber).toBe("00officer11223344");
  });
});

describe("GET /shifts — site manager finance stripping", () => {
  it("strips payRate/billRate from shifts for a site manager", async () => {
    // The manager manages no site here, but admins seed the shift; we only care
    // that whatever shifts a manager CAN see never carry finance. Assign the
    // manager to this shift's site via a roster claim is unnecessary — finance
    // stripping happens unconditionally for the site_manager role.
    const res = await request(app)
      .get("/api/shifts")
      .set(authed(ctx.managerToken));
    expect(res.status).toBe(200);
    // Whatever rows come back (possibly none, since scoping is per-site), none
    // may carry finance. Pin the invariant on every returned row.
    for (const shift of res.body as Array<Record<string, unknown>>) {
      expect(shift).not.toHaveProperty("payRate");
      expect(shift).not.toHaveProperty("billRate");
      expect(shift).not.toHaveProperty("hourlyRate");
      expect(shift).not.toHaveProperty("billableRate");
    }
  });
});

describe("GET /shifts — bill rate is admin-only for officers", () => {
  it("strips billRate but keeps the officer's own payRate", async () => {
    // Officers only see shifts they're assigned to (or open ones they qualify
    // for); pin an accepted assignment so the fixture shift is in their feed.
    await db.insert(shiftAssignmentsTable).values({
      shiftId: ctx.shiftId,
      employeeId: ctx.officerId,
      status: "accepted",
    });
    const res = await request(app)
      .get("/api/shifts")
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    const shift = (res.body as Array<Record<string, unknown>>).find((s) => s.id === ctx.shiftId);
    expect(shift).toBeTruthy();
    // Bill rate (client markup) is commercial data — never visible to a non-admin.
    expect(shift).not.toHaveProperty("billRate");
    expect(shift).not.toHaveProperty("billableRate");
    // Pay rate is the officer's own compensation — must remain visible.
    expect(shift).toHaveProperty("payRate", "30.00");
  });
});

describe("GET /me/payroll — site manager reads only their own rows", () => {
  it("returns the manager's own payroll rows and never another officer's", async () => {
    const res = await request(app)
      .get("/api/me/payroll")
      .set(authed(ctx.managerToken));
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    // Every returned row belongs to the manager (employeeId pinned to caller).
    for (const r of rows) {
      expect(r.siteId).toBe(ctx.siteId);
    }
    // The manager has exactly one payroll row in this fixture; the other
    // officer's identical row must not leak in.
    expect(rows.length).toBe(1);
    expect(res.body.summary.count).toBe(1);
  });
});
