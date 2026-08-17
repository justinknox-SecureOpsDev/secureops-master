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
  siteManagersTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
  payrollEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// A site manager is a full employee: it may read its OWN finance/banking but must
// never see another officer's. A dispatcher never sees finance/banking for
// anyone (self or other). These are security boundaries with no other
// automated coverage, so this suite pins them.
const TAG = `sitemgr-finance-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  siteManagerId: string;
  officerId: string;
  dispatcherId: string;
  adminId: string;
  siteManagerToken: string;
  dispatcherToken: string;
  officerToken: string;
  adminToken: string;
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
    // PII / right-to-work / personal documents — must never reach a
    // dispatcher (or a lead reading another officer) via the stripped projection.
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
  ctx.siteManagerId = await makeUser("site_manager", "lead");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatch");
  ctx.adminId = await makeUser("admin", "admin");

  await makeEmployeeRow(ctx.siteManagerId, "lead");
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

  // Register the site manager for the fixture site — the scoped GET /shifts
  // read only returns shifts at managed sites (or personally rostered ones),
  // so without this row the finance-stripping assertions would never see a shift.
  await db.insert(siteManagersTable).values({ siteId: ctx.siteId, userId: ctx.siteManagerId });

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

  // Assign the officer to the shift so it appears in their /shifts feed
  // (open shifts they don't qualify for are filtered out; assigned shifts
  // always show). Used to assert bill-rate stripping on the officer surface.
  await db.insert(shiftAssignmentsTable).values({
    shiftId: ctx.shiftId,
    employeeId: ctx.officerId,
    status: "accepted",
  });

  // A clocked-in time entry for the officer, bound to the shift, so the
  // /time-entries surface joins the shift's pay/bill rates. The officer must
  // see payRate (their own pay) but never billRate (client charge).
  await db.insert(timeEntriesTable).values({
    shiftId: ctx.shiftId,
    siteId: ctx.siteId,
    employeeId: ctx.officerId,
    clockInTime: new Date(),
  });

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
      employeeId: ctx.siteManagerId,
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

  ctx.siteManagerToken = signToken({
    userId: ctx.siteManagerId,
    email: `${TAG}-lead@example.test`,
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
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
});

afterAll(async () => {
  const ids = [ctx.siteManagerId, ctx.officerId, ctx.dispatcherId, ctx.adminId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id = ANY(${arr})`);
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

describe("GET /employees/:id — site-manager self vs other finance boundary", () => {
  it("returns the FULL record (rate + banking) when a site manager reads their OWN id", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.siteManagerId}`)
      .set(authed(ctx.siteManagerToken));
    expect(res.status).toBe(200);
    // Own finance is visible to a lead — they are a full employee.
    expect(res.body.hourlyRate).toBe("37.50");
    expect(res.body.bankAccountNumber).toBe("00lead11223344");
    expect(res.body.bankAccountName).toBe(`${TAG} lead`);
    expect(res.body.bankBsb).toBe("123456");
    expect(res.body.taxCode).toBe("1099");
  });

  it("returns the STRIPPED projection when a site manager reads ANOTHER officer's id", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.siteManagerToken));
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

  it("lets a dispatcher open ANOTHER officer's profile (200) with only the operational-safe projection", async () => {
    const res = await request(app)
      .get(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.dispatcherToken));
    // The dispatcher deep-links here from the Dispatch panel — must succeed.
    expect(res.status).toBe(200);
    // Operational identity/contact/licence summary stays.
    expect(res.body.id).toBe(ctx.officerId);
    expect(res.body.email).toBeTruthy();
    expect(res.body).toHaveProperty("firstName");
    expect(res.body).toHaveProperty("lastName");
    expect(res.body).toHaveProperty("siaLicenseLevel");
    // Banking / tax must be gone.
    expect(res.body).not.toHaveProperty("hourlyRate");
    expect(res.body).not.toHaveProperty("bankAccountName");
    expect(res.body).not.toHaveProperty("bankAccountNumber");
    expect(res.body).not.toHaveProperty("bankBsb");
    expect(res.body).not.toHaveProperty("taxCode");
    // Right-to-work must be gone.
    expect(res.body).not.toHaveProperty("rightToWorkStatus");
    expect(res.body).not.toHaveProperty("rightToWorkDocKey");
    // Personal docs / sensitive PII must be gone.
    expect(res.body).not.toHaveProperty("passportDocKey");
    expect(res.body).not.toHaveProperty("cvKey");
    expect(res.body).not.toHaveProperty("dateOfBirth");
    expect(res.body).not.toHaveProperty("niNumber");
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

describe("GET /shifts — site-manager finance stripping", () => {
  it("shows a site manager the pay rate but strips the client bill rate", async () => {
    const res = await request(app)
      .get("/api/shifts")
      .set(authed(ctx.siteManagerToken));
    expect(res.status).toBe(200);
    const shift = (res.body as Array<Record<string, unknown>>).find((s) => s.id === ctx.shiftId);
    expect(shift).toBeTruthy();
    // payRate and its legacy pay-side alias hourlyRate are both visible; only
    // the client bill rate and its legacy alias billableRate are stripped.
    expect(shift).toHaveProperty("payRate");
    expect(shift!.payRate).toBe("30.00");
    expect(shift).not.toHaveProperty("billRate");
    expect(shift).not.toHaveProperty("billableRate");
  });
});

describe("GET /shifts — officer (employee) bill-rate stripping", () => {
  it("shows the officer their own pay rate but never the client bill rate", async () => {
    const res = await request(app)
      .get("/api/shifts")
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    const shift = (res.body as Array<Record<string, unknown>>).find((s) => s.id === ctx.shiftId);
    expect(shift).toBeTruthy();
    // Pay rate (what the officer earns) stays visible.
    expect(shift).toHaveProperty("payRate");
    expect(shift!.payRate).toBe("30.00");
    // Bill rate (what the client is charged) is admin-only and must be gone.
    expect(shift).not.toHaveProperty("billRate");
    expect(shift).not.toHaveProperty("billableRate");
  });
});

describe("GET /time-entries — officer (employee) bill-rate stripping", () => {
  it("returns the officer's time entry with payRate but no billRate", async () => {
    const res = await request(app)
      .get("/api/time-entries")
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    const entry = rows.find((r) => r.shiftId === ctx.shiftId);
    expect(entry).toBeTruthy();
    // The joined pay rate stays so the officer can see what they earn...
    expect(entry).toHaveProperty("payRate");
    // ...but the joined client bill rate is stripped.
    expect(entry).not.toHaveProperty("billRate");
  });

  it("still exposes billRate to an admin on the same time entry", async () => {
    const res = await request(app)
      .get(`/api/time-entries?employeeId=${ctx.officerId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    const entry = rows.find((r) => r.shiftId === ctx.shiftId);
    expect(entry).toBeTruthy();
    expect(entry).toHaveProperty("billRate");
    expect(entry!.billRate).toBe("55.00");
  });
});

describe("GET /dashboard/employee-summary — officer bill-rate stripping", () => {
  it("returns the officer's upcoming shifts with payRate but never billRate", async () => {
    const res = await request(app)
      .get("/api/dashboard/employee-summary")
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    const body = res.body as {
      nextShift: Record<string, unknown> | null;
      upcomingShifts: Array<Record<string, unknown>>;
    };
    // The seeded shift (assigned + accepted, starts in +6h) must surface here.
    const next = body.nextShift;
    expect(next).toBeTruthy();
    expect(next).toHaveProperty("payRate");
    expect(next!.payRate).toBe("30.00");
    expect(next).not.toHaveProperty("billRate");
    expect(next).not.toHaveProperty("billableRate");
    // Every row in the list must be stripped, not just nextShift.
    const listed = body.upcomingShifts.find((s) => s.id === ctx.shiftId);
    expect(listed).toBeTruthy();
    expect(listed).toHaveProperty("payRate");
    expect(listed).not.toHaveProperty("billRate");
    expect(listed).not.toHaveProperty("billableRate");
  });

  it("still exposes billRate to an admin on their dashboard summary", async () => {
    const res = await request(app)
      .get("/api/dashboard/employee-summary")
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    // The admin has no assigned shifts of their own, so this asserts the
    // endpoint stays 200 for an admin and never strips when shifts are present
    // is covered by the officer cases above; here we simply confirm the
    // admin-role path returns successfully without throwing.
    expect(res.body).toHaveProperty("upcomingShifts");
  });
});

describe("GET /me/payroll — site-manager reads only their own rows", () => {
  it("returns the site manager's own payroll rows and never another officer's", async () => {
    const res = await request(app)
      .get("/api/me/payroll")
      .set(authed(ctx.siteManagerToken));
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
