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
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Executive-protection ("PPO Detail") package authorization.
 *
 * The package carries the most sensitive PII in the system (principal/threat
 * demographics + photos, medical notes), so the read/write/photo-sign
 * boundaries are security-critical and pinned here:
 *   - READ (GET /shifts/:id/protection-detail): admin/dispatcher/lead OR an
 *     `employee` with an ACCEPTED assignment to that shift. Everyone else 403.
 *   - WRITE (PUT): admin only.
 *   - PHOTO SIGN (/me/storage/sign for a protection photo): mirrors the READ
 *     rule — accepted officer or staff reader may sign; others 403.
 */
const TAG = `ppo-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);
const PHOTO_KEY = `/objects/uploads/protection/${TAG}.jpg`;

type Ctx = {
  adminId: string;
  dispatcherId: string;
  leadId: string;
  acceptedOfficerId: string;
  pendingOfficerId: string;
  unassignedOfficerId: string;
  clientUserId: string;
  adminToken: string;
  dispatcherToken: string;
  leadToken: string;
  acceptedToken: string;
  pendingToken: string;
  unassignedToken: string;
  clientToken: string;
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
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeEmployeeRow(userId: string): Promise<void> {
  await db.insert(employeesTable).values({ userId, position: "officer", skills: [] });
}

function tokenFor(id: string, role: string, suffix: string): string {
  return signToken({ userId: id, email: `${TAG}-${suffix}@example.test`, role });
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatch");
  ctx.leadId = await makeUser("lead", "lead");
  ctx.acceptedOfficerId = await makeUser("employee", "accepted");
  ctx.pendingOfficerId = await makeUser("employee", "pending");
  ctx.unassignedOfficerId = await makeUser("employee", "unassigned");
  ctx.clientUserId = await makeUser("client", "client");

  // Lead + officers are full employees. Admin/dispatcher/client intentionally
  // have NO employee row — this also exercises that staff readers can sign
  // protection photos via /me/storage/sign without an employee record.
  await makeEmployeeRow(ctx.leadId);
  await makeEmployeeRow(ctx.acceptedOfficerId);
  await makeEmployeeRow(ctx.pendingOfficerId);
  await makeEmployeeRow(ctx.unassignedOfficerId);

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
      headcount: 3,
      status: "upcoming",
      shiftType: "ppo_detail",
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  await db.insert(shiftAssignmentsTable).values([
    { shiftId: ctx.shiftId, employeeId: ctx.acceptedOfficerId, status: "accepted" },
    { shiftId: ctx.shiftId, employeeId: ctx.pendingOfficerId, status: "pending_approval" },
  ]);

  ctx.adminToken = tokenFor(ctx.adminId, "admin", "admin");
  ctx.dispatcherToken = tokenFor(ctx.dispatcherId, "dispatcher", "dispatch");
  ctx.leadToken = tokenFor(ctx.leadId, "lead", "lead");
  ctx.acceptedToken = tokenFor(ctx.acceptedOfficerId, "employee", "accepted");
  ctx.pendingToken = tokenFor(ctx.pendingOfficerId, "employee", "pending");
  ctx.unassignedToken = tokenFor(ctx.unassignedOfficerId, "employee", "unassigned");
  ctx.clientToken = tokenFor(ctx.clientUserId, "client", "client");
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shift_assignments WHERE shift_id = ${ctx.shiftId}`);
  await db.execute(sql`DELETE FROM protection_persons WHERE shift_id = ${ctx.shiftId}`);
  await db.execute(sql`DELETE FROM protection_destinations WHERE shift_id = ${ctx.shiftId}`);
  await db.execute(sql`DELETE FROM protection_details WHERE shift_id = ${ctx.shiftId}`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (
    SELECT id FROM users WHERE last_name = ${TAG}
  )`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function protUrl() {
  return `/api/shifts/${ctx.shiftId}/protection-detail`;
}

describe("PUT /shifts/:id/protection-detail — write authorization", () => {
  it("forbids a dispatcher (non-admin staff reader) from writing (403)", async () => {
    const res = await request(app)
      .put(protUrl())
      .set(authed(ctx.dispatcherToken))
      .send({ threatLevel: "high" });
    expect(res.status).toBe(403);
  });

  it("forbids a lead from writing (403)", async () => {
    const res = await request(app)
      .put(protUrl())
      .set(authed(ctx.leadToken))
      .send({ threatLevel: "high" });
    expect(res.status).toBe(403);
  });

  it("forbids an accepted officer from writing (403)", async () => {
    const res = await request(app)
      .put(protUrl())
      .set(authed(ctx.acceptedToken))
      .send({ threatLevel: "high" });
    expect(res.status).toBe(403);
  });

  it("lets an admin build the package (200) and persists it", async () => {
    const res = await request(app)
      .put(protUrl())
      .set(authed(ctx.adminToken))
      .send({
        threatLevel: "elevated",
        missionSummary: `${TAG} mission`,
        principals: [
          { name: "Principal One", relationship: "CEO", age: "early 40s", photoKeys: [PHOTO_KEY] },
        ],
        threats: [{ name: "Subject X", notes: "loiterer" }],
        // Explicit coords so the server skips network geocoding in the test.
        destinations: [{ label: "HQ", address: "100 Congress Ave", lat: 30.27, lng: -97.74 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.threatLevel).toBe("elevated");
    expect(res.body.principals).toHaveLength(1);
    expect(res.body.principals[0].name).toBe("Principal One");
    // Age is a free-text demographic string, never coerced to a number.
    expect(res.body.principals[0].age).toBe("early 40s");
    expect(res.body.principals[0].photoKeys).toContain(PHOTO_KEY);
    expect(res.body.threats).toHaveLength(1);
    expect(res.body.destinations).toHaveLength(1);
    expect(res.body.destinations[0].lat).toBe(30.27);
  });
});

describe("GET /shifts/:id/protection-detail — read authorization", () => {
  it("rejects an unauthenticated request (401)", async () => {
    const res = await request(app).get(protUrl());
    expect(res.status).toBe(401);
  });

  it("lets an admin read (200)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.shiftId).toBe(ctx.shiftId);
  });

  it("lets a dispatcher read (200)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.dispatcherToken));
    expect(res.status).toBe(200);
  });

  it("lets a lead read (200)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.leadToken));
    expect(res.status).toBe(200);
  });

  it("lets an officer with an ACCEPTED assignment read (200)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.acceptedToken));
    expect(res.status).toBe(200);
    expect(res.body.principals[0].name).toBe("Principal One");
  });

  it("forbids an officer with a PENDING (not accepted) assignment (403)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.pendingToken));
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty("principals");
  });

  it("forbids an unassigned officer (403)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.unassignedToken));
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty("principals");
  });

  it("forbids an external client portal user (403)", async () => {
    const res = await request(app).get(protUrl()).set(authed(ctx.clientToken));
    expect(res.status).toBe(403);
  });
});

describe("GET /me/storage/sign — protection photo authorization", () => {
  // 403 is the authorization signal we assert on. Authorized callers fall
  // through to the object-storage signer, which may itself 200/404/500 in the
  // test env (no live sidecar) — the security boundary is "not 403".
  const signUrl = `/api/me/storage/sign?path=${encodeURIComponent(PHOTO_KEY)}`;

  it("authorizes an accepted officer to sign the protection photo (not 403)", async () => {
    const res = await request(app).get(signUrl).set(authed(ctx.acceptedToken));
    expect(res.status).not.toBe(403);
  });

  it("authorizes a staff reader without an employee row (dispatcher) (not 403)", async () => {
    const res = await request(app).get(signUrl).set(authed(ctx.dispatcherToken));
    expect(res.status).not.toBe(403);
  });

  it("authorizes an admin without an employee row (not 403)", async () => {
    const res = await request(app).get(signUrl).set(authed(ctx.adminToken));
    expect(res.status).not.toBe(403);
  });

  it("forbids a pending (not accepted) officer (403)", async () => {
    const res = await request(app).get(signUrl).set(authed(ctx.pendingToken));
    expect(res.status).toBe(403);
  });

  it("forbids an unassigned officer (403)", async () => {
    const res = await request(app).get(signUrl).set(authed(ctx.unassignedToken));
    expect(res.status).toBe(403);
  });

  it("forbids an external client portal user (403)", async () => {
    const res = await request(app).get(signUrl).set(authed(ctx.clientToken));
    expect(res.status).toBe(403);
  });
});
