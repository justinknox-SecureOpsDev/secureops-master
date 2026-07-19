import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  siteRatesTable,
  shiftsTable,
  timeEntriesTable,
  siteManagersTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Per-site scoping for the `site_manager` role. A site manager's authority is
 * confined to the sites they are assigned to (rows in `site_managers`). These
 * boundaries are security-critical (cross-site = another client's operational
 * data / officer PII), so the read/write/approve surfaces are pinned here:
 *   - GET /shifts: only shifts at managed sites (zero-site manager → none).
 *   - GET /shifts/:id, POST /shifts, time-entry approve: 403 off-site, OK on-site.
 *   - Manager-assignment routes (admin-only write; scoped read).
 * Admins bypass every check; dispatchers are global and unchanged.
 */
const TAG = `mgr-scope-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  dispatcherId: string;
  managerAId: string; // manages siteA
  otherManagerId: string; // manages siteB
  zeroManagerId: string; // manages nothing (note: later PUT tests assign it to siteC)
  isolatedMgrId: string; // manages nothing AND is never reassigned by any test
  officerId: string;
  adminToken: string;
  dispatcherToken: string;
  managerAToken: string;
  otherManagerToken: string;
  zeroManagerToken: string;
  isolatedMgrToken: string;
  clientId: string;
  clientId2: string; // owns siteD; managerA does NOT manage siteD (cross-site PII check)
  siteAId: string;
  siteBId: string;
  siteCId: string; // used only for the replace-all PUT tests (kept isolated)
  siteDId: string; // owned by clientId2, not managed by managerA
  siteEId: string; // second site under client1 that managerA ALSO manages (move test)
  siteRateAId: string; // a real site_rates card on siteA (siteRateId-ignored check)
  shiftAId: string;
  shiftBId: string;
  entryAId: string;
  entryBId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeSite(name: string): Promise<string> {
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-${name}`,
      address: `1 ${name} Way`,
      // Site managers inherit rates from site defaults; non-zero defaults let a
      // managed-site POST succeed and isolate the off-site case to a pure 403.
      defaultPayRate: "30.00",
      defaultBillRate: "55.00",
    })
    .returning({ id: sitesTable.id });
  return site.id;
}

async function makeShift(siteId: string, name: string): Promise<string> {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-${name}`,
      siteId,
      startTime: start,
      endTime: end,
      payRate: "30.00",
      billRate: "55.00",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  return shift.id;
}

async function makeClockedOutEntry(siteId: string): Promise<string> {
  const clockIn = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const clockOut = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: ctx.officerId,
      siteId,
      clockInTime: clockIn,
      clockOutTime: clockOut,
      hoursWorked: "4.00",
      approvalStatus: "pending",
    })
    .returning({ id: timeEntriesTable.id });
  return entry.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatch");
  ctx.managerAId = await makeUser("site_manager", "managerA");
  ctx.otherManagerId = await makeUser("site_manager", "otherMgr");
  ctx.zeroManagerId = await makeUser("site_manager", "zeroMgr");
  ctx.isolatedMgrId = await makeUser("site_manager", "isoMgr");
  ctx.officerId = await makeUser("employee", "officer");

  await db.insert(employeesTable).values([
    { userId: ctx.managerAId, position: "officer", skills: [] },
    { userId: ctx.otherManagerId, position: "officer", skills: [] },
    { userId: ctx.zeroManagerId, position: "officer", skills: [] },
    { userId: ctx.officerId, position: "officer", skills: [] },
  ]);

  const [client] = await db
    .insert(clientsTable)
    .values({
      name: `${TAG}-client`,
      paymentTermsDays: 14,
      billingAddress: "100 Billing Rd",
      contactName: "Pat Contact",
      contactEmail: "pat@client.test",
      contactPhone: "+15125550100",
      notes: "internal client note",
    })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  ctx.siteAId = await makeSite("siteA");
  ctx.siteBId = await makeSite("siteB");
  ctx.siteCId = await makeSite("siteC");

  // A second client owning a site managerA does NOT manage — proves the /clients
  // list never leaks cross-site client contact PII to a site manager.
  const [client2] = await db
    .insert(clientsTable)
    .values({
      name: `${TAG}-client2`,
      paymentTermsDays: 7,
      contactName: "Other Contact",
      contactEmail: "other@client2.test",
    })
    .returning({ id: clientsTable.id });
  ctx.clientId2 = client2.id;
  const [siteD] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId2,
      name: `${TAG}-siteD`,
      address: "4 siteD Way",
      defaultPayRate: "30.00",
      defaultBillRate: "55.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteDId = siteD.id;

  // A real rate card on siteA — proves a site manager's siteRateId is ignored on
  // create (it must persist as null, never this id).
  const [rateA] = await db
    .insert(siteRatesTable)
    .values({
      siteId: ctx.siteAId,
      licenseLevel: 2,
      payRate: "30.00",
      billRate: "55.00",
      label: "Standard",
    })
    .returning({ id: siteRatesTable.id });
  ctx.siteRateAId = rateA.id;

  // siteE: a SECOND site under client1 that managerA also manages — lets us test a
  // site manager moving a shift across two managed sites (rate-card FK must clear).
  ctx.siteEId = await makeSite("siteE");

  await db.insert(siteManagersTable).values([
    { siteId: ctx.siteAId, userId: ctx.managerAId },
    { siteId: ctx.siteEId, userId: ctx.managerAId },
    { siteId: ctx.siteBId, userId: ctx.otherManagerId },
  ]);

  ctx.shiftAId = await makeShift(ctx.siteAId, "shiftA");
  ctx.shiftBId = await makeShift(ctx.siteBId, "shiftB");
  ctx.entryAId = await makeClockedOutEntry(ctx.siteAId);
  ctx.entryBId = await makeClockedOutEntry(ctx.siteBId);

  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.dispatcherToken = signToken({ userId: ctx.dispatcherId, email: `${TAG}-dispatch@example.test`, role: "dispatcher" });
  ctx.managerAToken = signToken({ userId: ctx.managerAId, email: `${TAG}-managerA@example.test`, role: "site_manager" });
  ctx.otherManagerToken = signToken({ userId: ctx.otherManagerId, email: `${TAG}-otherMgr@example.test`, role: "site_manager" });
  ctx.zeroManagerToken = signToken({ userId: ctx.zeroManagerId, email: `${TAG}-zeroMgr@example.test`, role: "site_manager" });
  ctx.isolatedMgrToken = signToken({ userId: ctx.isolatedMgrId, email: `${TAG}-isoMgr@example.test`, role: "site_manager" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  // invoice line items are a jsonb column on invoices, not a separate table.
  await db.execute(sql`DELETE FROM invoices WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM site_managers WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("GET /shifts — per-site list scoping", () => {
  it("returns only shifts at the manager's assigned site", async () => {
    const res = await request(app).get("/api/shifts").set(authed(ctx.managerAToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(ctx.shiftAId);
    expect(ids).not.toContain(ctx.shiftBId);
  });

  it("returns NO managed shifts for a manager assigned to no sites", async () => {
    const res = await request(app).get("/api/shifts").set(authed(ctx.zeroManagerToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(ctx.shiftAId);
    expect(ids).not.toContain(ctx.shiftBId);
  });

  it("lets an admin see shifts at every site (global)", async () => {
    const res = await request(app).get("/api/shifts").set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(ctx.shiftAId);
    expect(ids).toContain(ctx.shiftBId);
  });
});

describe("GET /shifts/:id — per-site detail scoping", () => {
  it("lets a manager read a shift at their site (200)", async () => {
    const res = await request(app).get(`/api/shifts/${ctx.shiftAId}`).set(authed(ctx.managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ctx.shiftAId);
  });

  it("forbids a manager reading a shift at a site they don't manage (403)", async () => {
    const res = await request(app).get(`/api/shifts/${ctx.shiftBId}`).set(authed(ctx.managerAToken));
    expect(res.status).toBe(403);
  });

  it("forbids a zero-site manager reading any shift (403)", async () => {
    const res = await request(app).get(`/api/shifts/${ctx.shiftAId}`).set(authed(ctx.zeroManagerToken));
    expect(res.status).toBe(403);
  });
});

describe("POST /shifts — per-site create scoping", () => {
  function shiftBody(siteId: string) {
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    return {
      title: `${TAG}-created`,
      siteId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      requiredLicenseLevel: 2,
      headcount: 1,
    };
  }

  it("lets a manager create a shift at their site (201)", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.managerAToken))
      .send(shiftBody(ctx.siteAId));
    expect(res.status).toBe(201);
    expect(res.body.siteId).toBe(ctx.siteAId);
    // Finance is stripped from a site manager's view even on their own create.
    expect(res.body).not.toHaveProperty("payRate");
    expect(res.body).not.toHaveProperty("billRate");
  });

  it("forbids a manager creating a shift at a site they don't manage (403)", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.managerAToken))
      .send(shiftBody(ctx.siteBId));
    expect(res.status).toBe(403);
  });

  it("forbids a zero-site manager creating a shift anywhere (403)", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.zeroManagerToken))
      .send(shiftBody(ctx.siteAId));
    expect(res.status).toBe(403);
  });
});

describe("POST /time-entries/:id/approve — per-site approval scoping", () => {
  it("lets a manager approve a time entry at their site (not 403)", async () => {
    const res = await request(app)
      .post(`/api/time-entries/${ctx.entryAId}/approve`)
      .set(authed(ctx.managerAToken))
      .send({ decision: "approved" });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it("forbids a manager approving a time entry at a site they don't manage (403)", async () => {
    const res = await request(app)
      .post(`/api/time-entries/${ctx.entryBId}/approve`)
      .set(authed(ctx.managerAToken))
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
  });

  it("forbids a zero-site manager approving any time entry (403)", async () => {
    const res = await request(app)
      .post(`/api/time-entries/${ctx.entryAId}/approve`)
      .set(authed(ctx.zeroManagerToken))
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
  });
});

describe("Manager-assignment routes", () => {
  it("GET /site-manager-candidates lists active site managers (admin-only)", async () => {
    const res = await request(app).get("/api/site-manager-candidates").set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.managerAId, ctx.otherManagerId, ctx.zeroManagerId]));
    // Non-managers must never appear as candidates.
    expect(ids).not.toContain(ctx.officerId);
    expect(ids).not.toContain(ctx.adminId);
  });

  it("forbids a non-admin from listing candidates (403)", async () => {
    const res = await request(app).get("/api/site-manager-candidates").set(authed(ctx.managerAToken));
    expect(res.status).toBe(403);
  });

  it("PUT /sites/:id/managers (admin) replaces the manager set", async () => {
    const res = await request(app)
      .put(`/api/sites/${ctx.siteCId}/managers`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.zeroManagerId, ctx.otherManagerId] });
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.zeroManagerId, ctx.otherManagerId]));
    expect(ids).toHaveLength(2);
  });

  it("rejects a PUT that includes a non-site-manager user (400)", async () => {
    const res = await request(app)
      .put(`/api/sites/${ctx.siteCId}/managers`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerId] });
    expect(res.status).toBe(400);
  });

  it("forbids a non-admin from replacing managers (403)", async () => {
    const res = await request(app)
      .put(`/api/sites/${ctx.siteAId}/managers`)
      .set(authed(ctx.managerAToken))
      .send({ userIds: [ctx.managerAId] });
    expect(res.status).toBe(403);
  });

  it("GET /sites/:id/managers — assigned manager may read their co-managers (200)", async () => {
    const res = await request(app).get(`/api/sites/${ctx.siteAId}/managers`).set(authed(ctx.managerAToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(ctx.managerAId);
  });

  it("GET /sites/:id/managers — a manager of a DIFFERENT site is forbidden (403)", async () => {
    const res = await request(app).get(`/api/sites/${ctx.siteAId}/managers`).set(authed(ctx.otherManagerToken));
    expect(res.status).toBe(403);
  });

  it("GET /sites/:id/managers — a dispatcher is forbidden (403)", async () => {
    const res = await request(app).get(`/api/sites/${ctx.siteAId}/managers`).set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(403);
  });
});

describe("GET /clients — site managers only see their managed-site clients", () => {
  it("returns only clients that own a managed site, with billing stripped", async () => {
    const res = await request(app).get("/api/clients").set(authed(ctx.managerAToken));
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(ctx.clientId); // owns siteA (managed)
    expect(ids).not.toContain(ctx.clientId2); // owns siteD (NOT managed) — no cross-site leak
    const managed = rows.find((r) => r.id === ctx.clientId)!;
    expect(managed).not.toHaveProperty("billingAddress");
    expect(managed).not.toHaveProperty("paymentTermsDays");
    // Contact PII + free-text notes are stripped too; only the client name (needed
    // to identify the client when scheduling) + harmless ids/timestamps remain.
    expect(managed).not.toHaveProperty("contactName");
    expect(managed).not.toHaveProperty("contactEmail");
    expect(managed).not.toHaveProperty("contactPhone");
    expect(managed).not.toHaveProperty("notes");
    expect(managed.name).toBe(`${TAG}-client`);
  });

  it("returns an empty list for a manager assigned to no sites", async () => {
    // Use the isolated manager — zeroManager gets assigned to siteC by an earlier
    // manager-assignment test, so it is no longer site-less by this point.
    const res = await request(app).get("/api/clients").set(authed(ctx.isolatedMgrToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("lets an admin see every client (global)", async () => {
    const res = await request(app).get("/api/clients").set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.clientId, ctx.clientId2]));
  });
});

describe("GET /sites — site managers only see their managed sites", () => {
  it("returns only managed sites (the create-shift picker must never offer a 403 site)", async () => {
    const res = await request(app).get("/api/sites").set(authed(ctx.managerAToken));
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.siteAId, ctx.siteEId]));
    expect(ids).not.toContain(ctx.siteBId); // otherMgr's site
    expect(ids).not.toContain(ctx.siteDId); // other client's site
  });

  it("keeps the clientId filter AND the managed scope (intersection, not override)", async () => {
    const res = await request(app)
      .get("/api/sites")
      .query({ clientId: ctx.clientId2 })
      .set(authed(ctx.managerAToken));
    expect(res.status).toBe(200);
    // client2 owns only siteD, which managerA does not manage — intersection is empty.
    expect(res.body).toEqual([]);
  });

  it("returns an empty list for a manager assigned to no sites", async () => {
    const res = await request(app).get("/api/sites").set(authed(ctx.isolatedMgrToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("leaves admin and dispatcher lists global", async () => {
    for (const token of [ctx.adminToken, ctx.dispatcherToken]) {
      const res = await request(app).get("/api/sites").set(authed(token));
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([ctx.siteAId, ctx.siteBId, ctx.siteDId]));
    }
  });
});

describe("POST /shifts — site manager cannot set rate-card linkage", () => {
  it("ignores a client-supplied siteRateId (persists null, never the supplied card)", async () => {
    const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.managerAToken))
      .send({
        title: `${TAG}-rate-tamper`,
        siteId: ctx.siteAId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        requiredLicenseLevel: 2,
        headcount: 1,
        siteRateId: ctx.siteRateAId,
      });
    expect(res.status).toBe(201);
    const [row] = await db
      .select({ siteRateId: shiftsTable.siteRateId })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, res.body.id));
    expect(row.siteRateId).toBeNull();
  });

  it("still lets an admin set a valid siteRateId", async () => {
    const start = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.adminToken))
      .send({
        title: `${TAG}-rate-admin`,
        siteId: ctx.siteAId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        requiredLicenseLevel: 2,
        headcount: 1,
        siteRateId: ctx.siteRateAId,
      });
    expect(res.status).toBe(201);
    const [row] = await db
      .select({ siteRateId: shiftsTable.siteRateId })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, res.body.id));
    expect(row.siteRateId).toBe(ctx.siteRateAId);
  });
});

describe("PUT /shifts — site manager cannot set or carry rate-card linkage", () => {
  // Admin creates a shift already linked to siteA's rate card; the manager edits
  // it. The manager must neither set nor retain that finance linkage improperly.
  async function adminCreateRatedShift(siteId: string, label: string): Promise<string> {
    const start = new Date(Date.now() + 120 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.adminToken))
      .send({
        title: `${TAG}-${label}`,
        siteId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        requiredLicenseLevel: 2,
        headcount: 1,
        payRate: "99.00",
        billRate: "199.00",
        siteRateId: ctx.siteRateAId,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("ignores a manager-supplied siteRateId on edit (same site keeps the admin's card)", async () => {
    const shiftId = await adminCreateRatedShift(ctx.siteAId, "put-rate-keep");
    const res = await request(app)
      .put(`/api/shifts/${shiftId}`)
      .set(authed(ctx.managerAToken))
      .send({ siteRateId: null, headcount: 2 });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ siteRateId: shiftsTable.siteRateId, headcount: shiftsTable.headcount, payRate: shiftsTable.payRate })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId));
    expect(row.siteRateId).toBe(ctx.siteRateAId); // manager's null was ignored
    expect(row.headcount).toBe(2); // non-finance edit still applied
    expect(row.payRate).toBe("99.00"); // finance untouched on a same-site edit
  });

  it("clears the rate-card FK when a manager moves a shift to another managed site", async () => {
    const shiftId = await adminCreateRatedShift(ctx.siteAId, "put-move-clear");
    const res = await request(app)
      .put(`/api/shifts/${shiftId}`)
      .set(authed(ctx.managerAToken))
      .send({ siteId: ctx.siteEId });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ siteId: shiftsTable.siteId, siteRateId: shiftsTable.siteRateId, payRate: shiftsTable.payRate, billRate: shiftsTable.billRate })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, shiftId));
    expect(row.siteId).toBe(ctx.siteEId); // moved to the other managed site
    expect(row.siteRateId).toBeNull(); // stale rate-card FK dropped
    expect(row.payRate).toBe("30.00"); // recomputed from destination site default
    expect(row.billRate).toBe("55.00"); // old 199 did NOT carry — recomputed from dest default
  });
});
