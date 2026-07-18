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
  timeEntriesTable,
  siteManagersTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// A site manager has site-SCOPED powers: they may create/edit shifts, approve
// shift claims, and approve time entries — but ONLY for sites listed in the
// site_managers join table. Admins are unscoped. These are the core
// authorization boundaries for the role, so this suite pins every write path.
const TAG = `sitemgr-authz-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  managerId: string;
  officerId: string;
  adminToken: string;
  managerToken: string;
  clientId: string;
  // siteA is MANAGED by the manager; siteB is NOT.
  siteAId: string;
  siteBId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Person",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeEmployeeRow(userId: string): Promise<void> {
  await db.insert(employeesTable).values({ userId, position: "officer", hourlyRate: "30.00", skills: [] });
}

async function makeSite(name: string): Promise<string> {
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-${name}`,
      address: "1 Test Way",
      // Site managers inherit rates from the site default; without usable
      // defaults the create-shift path fails closed, so seed them here.
      defaultPayRate: "30.00",
      defaultBillRate: "55.00",
    })
    .returning({ id: sitesTable.id });
  return site.id;
}

async function makeShiftRow(siteId: string, startHoursFromNow = 6): Promise<string> {
  const start = new Date(Date.now() + startHoursFromNow * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId,
      startTime: start,
      endTime: end,
      payRate: "30.00",
      billRate: "55.00",
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  return shift.id;
}

async function makeClockedOutEntry(siteId: string, shiftId?: string): Promise<string> {
  const clockIn = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const clockOut = new Date(Date.now() - 1 * 60 * 60 * 1000);
  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      siteId,
      shiftId: shiftId ?? null,
      employeeId: ctx.officerId,
      clockInTime: clockIn,
      clockOutTime: clockOut,
      approvalStatus: "pending",
    })
    .returning({ id: timeEntriesTable.id });
  return entry.id;
}

async function makePendingClaim(shiftId: string): Promise<string> {
  const [a] = await db
    .insert(shiftAssignmentsTable)
    .values({ shiftId, employeeId: ctx.officerId, status: "pending_approval" })
    .returning({ id: shiftAssignmentsTable.id });
  return a.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.managerId = await makeUser("site_manager", "mgr");
  ctx.officerId = await makeUser("employee", "officer");
  await makeEmployeeRow(ctx.managerId);
  await makeEmployeeRow(ctx.officerId);

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  ctx.siteAId = await makeSite("siteA");
  ctx.siteBId = await makeSite("siteB");

  // Assign the manager to siteA ONLY.
  await db.insert(siteManagersTable).values({ siteId: ctx.siteAId, userId: ctx.managerId, assignedBy: ctx.adminId });

  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.managerToken = signToken({ userId: ctx.managerId, email: `${TAG}-mgr@example.test`, role: "site_manager" });
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.managerId, ctx.officerId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM site_managers WHERE user_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("POST /shifts — site-manager site scope", () => {
  const body = (siteId: string | null) => ({
    title: `${TAG}-shift`,
    siteId,
    startTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    requiredLicenseLevel: 2,
    headcount: 1,
  });

  it("lets a manager create a shift at a site they manage (201)", async () => {
    const res = await request(app).post("/api/shifts").set(authed(ctx.managerToken)).send(body(ctx.siteAId));
    expect(res.status).toBe(201);
  });

  it("forbids a manager from creating a shift at a site they do NOT manage (403)", async () => {
    const res = await request(app).post("/api/shifts").set(authed(ctx.managerToken)).send(body(ctx.siteBId));
    expect(res.status).toBe(403);
  });

  it("rejects a manager creating a shift with no site (400)", async () => {
    const res = await request(app).post("/api/shifts").set(authed(ctx.managerToken)).send(body(null));
    expect(res.status).toBe(400);
  });

  it("lets an admin create a shift at any site, managed or not (201)", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.adminToken))
      .send({ ...body(ctx.siteBId), payRate: "30.00", billRate: "55.00" });
    expect(res.status).toBe(201);
  });
});

describe("POST /time-entries/:id/approve — site-manager site scope", () => {
  it("lets a manager approve a time entry at a managed site (200)", async () => {
    const entryId = await makeClockedOutEntry(ctx.siteAId);
    const res = await request(app)
      .post(`/api/time-entries/${entryId}/approve`)
      .set(authed(ctx.managerToken))
      .send({ decision: "approved" });
    expect(res.status).toBe(200);
  });

  it("forbids a manager approving a time entry at an unmanaged site (403)", async () => {
    const entryId = await makeClockedOutEntry(ctx.siteBId);
    const res = await request(app)
      .post(`/api/time-entries/${entryId}/approve`)
      .set(authed(ctx.managerToken))
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
  });

  it("lets an admin approve a time entry at any site (200)", async () => {
    const entryId = await makeClockedOutEntry(ctx.siteBId);
    const res = await request(app)
      .post(`/api/time-entries/${entryId}/approve`)
      .set(authed(ctx.adminToken))
      .send({ decision: "approved" });
    expect(res.status).toBe(200);
  });
});

describe("PUT /shifts/:id/assignments/:assignmentId — site-manager claim approval scope", () => {
  it("lets a manager approve a pending claim at a managed site (200)", async () => {
    const shiftId = await makeShiftRow(ctx.siteAId);
    const assignmentId = await makePendingClaim(shiftId);
    const res = await request(app)
      .put(`/api/shifts/${shiftId}/assignments/${assignmentId}`)
      .set(authed(ctx.managerToken))
      .send({ status: "accepted" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
  });

  it("forbids a manager approving a pending claim at an unmanaged site (403)", async () => {
    const shiftId = await makeShiftRow(ctx.siteBId);
    const assignmentId = await makePendingClaim(shiftId);
    const res = await request(app)
      .put(`/api/shifts/${shiftId}/assignments/${assignmentId}`)
      .set(authed(ctx.managerToken))
      .send({ status: "accepted" });
    expect(res.status).toBe(403);
  });
});

describe("GET /time-entries — site-manager list scoped to managed sites", () => {
  it("returns entries at managed sites and never entries at unmanaged sites", async () => {
    const managedEntryId = await makeClockedOutEntry(ctx.siteAId);
    const unmanagedEntryId = await makeClockedOutEntry(ctx.siteBId);
    const res = await request(app).get("/api/time-entries").set(authed(ctx.managerToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(managedEntryId);
    expect(ids).not.toContain(unmanagedEntryId);
  });

  it("never exposes any rate (payRate or billRate) to a site manager", async () => {
    // Link the entry to a shift so the joined payRate/billRate are non-null at
    // the source — proving the strip removes them, not that they were absent.
    const shiftId = await makeShiftRow(ctx.siteAId);
    const entryId = await makeClockedOutEntry(ctx.siteAId, shiftId);

    const mgrRes = await request(app).get("/api/time-entries").set(authed(ctx.managerToken));
    expect(mgrRes.status).toBe(200);
    const mgrRow = (mgrRes.body as Array<{ id: string }>).find((r) => r.id === entryId);
    expect(mgrRow).toBeDefined();
    expect(mgrRow).not.toHaveProperty("payRate");
    expect(mgrRow).not.toHaveProperty("billRate");

    // Control: an admin DOES see the rates, confirming they exist at the source.
    const adminRes = await request(app).get("/api/time-entries").set(authed(ctx.adminToken));
    const adminRow = (adminRes.body as Array<{ id: string }>).find((r) => r.id === entryId);
    expect(adminRow).toHaveProperty("payRate");
    expect(adminRow).toHaveProperty("billRate");
  });
});

describe("POST /shifts/:id/assignments — site-manager manual assignment scope", () => {
  it("forbids a manager assigning at an unmanaged site (403, before the licence gate)", async () => {
    const shiftId = await makeShiftRow(ctx.siteBId);
    const res = await request(app)
      .post(`/api/shifts/${shiftId}/assignments`)
      .set(authed(ctx.managerToken))
      .send({ employeeId: ctx.officerId, overrideLicense: true });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not manage this site/i);
  });

  it("does NOT let a manager override the licence gate at a managed site (403)", async () => {
    // Officer has no licence (effective level 0) and the shift needs level 2.
    // overrideLicense is admin/dispatcher-only, so a manager is still blocked.
    const shiftId = await makeShiftRow(ctx.siteAId);
    const res = await request(app)
      .post(`/api/shifts/${shiftId}/assignments`)
      .set(authed(ctx.managerToken))
      .send({ employeeId: ctx.officerId, overrideLicense: true });
    expect(res.status).toBe(403);
    expect(res.body.message).not.toMatch(/do not manage this site/i);
  });

  it("lets an admin override the licence gate and assign (201)", async () => {
    // Far-future window so it can't double-book the officer's accepted
    // assignment created by the earlier claim-approval test.
    const shiftId = await makeShiftRow(ctx.siteBId, 48);
    const res = await request(app)
      .post(`/api/shifts/${shiftId}/assignments`)
      .set(authed(ctx.adminToken))
      .send({ employeeId: ctx.officerId, overrideLicense: true });
    expect(res.status).toBe(201);
  });
});
