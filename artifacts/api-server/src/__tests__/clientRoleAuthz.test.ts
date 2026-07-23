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
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import {
  stripShiftFinanceForRole,
  stripTimeEntryBillRateForRole,
} from "../lib/financeVisibility";

// External client-portal contacts (role="client") must NEVER reach internal
// staff surfaces: shift rows carry officer payRate, rosters carry officers'
// full names, time entries carry pay data, and /employees/:id is the officer
// PII record. Clients get their own sanitized /client/* portal instead.
// This suite pins the requireStaff boundary on every surface a client could
// previously reach via bare requireAuth.
const TAG = `client-authz-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  clientUserId: string;
  clientToken: string;
  officerId: string;
  officerToken: string;
  clientOrgId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-org`, contactEmail: `${TAG}@example.test` })
    .returning({ id: clientsTable.id });
  ctx.clientOrgId = org.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: org.id, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [clientUser] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-client@example.test`,
      passwordHash,
      firstName: "Client",
      lastName: TAG,
      role: "client",
      status: "active",
      clientId: org.id,
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.clientUserId = clientUser.id;
  ctx.clientToken = signToken({ userId: clientUser.id, email: `${TAG}-client@example.test`, role: "client" });

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
  ctx.officerToken = signToken({ userId: officer.id, email: `${TAG}-officer@example.test`, role: "employee" });

  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: site.id,
      startTime: start,
      endTime: end,
      status: "upcoming",
      payRate: "30.00",
      billRate: "55.00",
      requiredLicenseLevel: 2,
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;
});

afterAll(async () => {
  await db.execute(sql`delete from shifts where title like ${`${TAG}%`}`);
  await db.execute(sql`delete from sites where name like ${`${TAG}%`}`);
  await db.execute(sql`delete from users where email like ${`${TAG}%`}`);
  await db.execute(sql`delete from clients where name like ${`${TAG}%`}`);
});

function asClient(path: string) {
  return request(app).get(path).set("Authorization", `Bearer ${ctx.clientToken}`);
}

describe("client role is rejected from staff surfaces", () => {
  const staffGets = [
    "/api/shifts",
    "/api/time-entries",
    "/api/time-entries/active",
    "/api/incidents",
    "/api/licenses",
    "/api/dashboard/employee-summary",
    "/api/me/payroll",
    "/api/me/dar",
    "/api/me/swap-requests",
    "/api/me/trainings",
    "/api/me/compliance",
    "/api/me/patrol/recent",
    "/api/me/payment-discrepancies",
    "/api/me/license-renewals",
  ];

  for (const path of staffGets) {
    it(`403s GET ${path}`, async () => {
      const res = await asClient(path);
      expect(res.status).toBe(403);
    });
  }

  it("403s GET /api/shifts/:id (officer payRate + roster names)", async () => {
    const res = await asClient(`/api/shifts/${ctx.shiftId}`);
    expect(res.status).toBe(403);
  });

  it("403s GET /api/employees/:id for another user (officer PII)", async () => {
    const res = await asClient(`/api/employees/${ctx.officerId}`);
    expect(res.status).toBe(403);
  });

  it("403s POST /api/storage/uploads/request-url (presigned upload minting)", async () => {
    const res = await request(app)
      .post("/api/storage/uploads/request-url")
      .set("Authorization", `Bearer ${ctx.clientToken}`)
      .send({ fileName: "x.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(403);
  });

  it("403s shift claim + clock-in writes", async () => {
    const claim = await request(app)
      .post(`/api/shifts/${ctx.shiftId}/claim`)
      .set("Authorization", `Bearer ${ctx.clientToken}`);
    expect(claim.status).toBe(403);

    const clockIn = await request(app)
      .post("/api/time-entries/clock-in")
      .set("Authorization", `Bearer ${ctx.clientToken}`)
      .send({ siteId: ctx.siteId });
    expect(clockIn.status).toBe(403);
  });

  it("officer (staff) still passes the same gates", async () => {
    const res = await request(app)
      .get("/api/shifts")
      .set("Authorization", `Bearer ${ctx.officerToken}`);
    expect(res.status).toBe(200);
  });

  it("client portal /client/shifts still works and never leaks rates or full names", async () => {
    const res = await asClient("/api/client/shifts");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("payRate");
    expect(body).not.toContain("billRate");
    expect(body).not.toContain("hourlyRate");
  });
});

describe("finance sanitizers strip every rate for the client role", () => {
  const shiftRow = { id: "x", payRate: "30", billRate: "55", hourlyRate: "30", billableRate: "55", title: "t" };
  const entryRow = { id: "x", payRate: "30", billRate: "55", hoursWorked: "4" };

  it("stripShiftFinanceForRole(client) removes pay AND bill rates", () => {
    const out = stripShiftFinanceForRole("client", shiftRow) as Record<string, unknown>;
    expect(out.payRate).toBeUndefined();
    expect(out.billRate).toBeUndefined();
    expect(out.hourlyRate).toBeUndefined();
    expect(out.billableRate).toBeUndefined();
    expect(out.title).toBe("t");
  });

  it("stripTimeEntryBillRateForRole(client) removes pay AND bill rates", () => {
    const out = stripTimeEntryBillRateForRole("client", entryRow) as Record<string, unknown>;
    expect(out.payRate).toBeUndefined();
    expect(out.billRate).toBeUndefined();
    expect(out.hoursWorked).toBe("4");
  });
});
