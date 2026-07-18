import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";

// The push fan-out to a site's managers is the surface under test. We mock
// lib/push so the route's recipient computation is observable without touching
// Expo or the notifications table. lib/sms is left REAL — without a Twilio
// connection it no-ops, so it never reaches the network in tests.
vi.mock("../lib/push", () => ({
  sendPushToUsers: vi.fn(() => Promise.resolve()),
}));

import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  licensesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";

const mockedSendPush = vi.mocked(sendPushToUsers);

const TAG = `sitemgr-notify-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  managerId: string;
  officerId: string;
  adminToken: string;
  officerToken: string;
  clientId: string;
  siteId: string;
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

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Find the push call whose payload announces the given notification type, and
// return the recipient id array it was invoked with (or null if never sent).
function recipientsForType(type: string): string[] | null {
  for (const call of mockedSendPush.mock.calls) {
    const [ids, payload] = call as [string[], { data?: { type?: string } }];
    if (payload?.data?.type === type) return ids;
  }
  return null;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.managerId = await makeUser("site_manager", "mgr");
  ctx.officerId = await makeUser("employee", "officer");
  await db.insert(employeesTable).values({ userId: ctx.managerId, position: "officer", hourlyRate: "30.00", skills: [] });
  await db.insert(employeesTable).values({ userId: ctx.officerId, position: "officer", hourlyRate: "30.00", skills: [] });
  // The officer needs an unexpired licence so they clear the claim eligibility
  // gate (level 4 covers every requiredLicenseLevel).
  await db.insert(licensesTable).values({
    employeeId: ctx.officerId,
    type: "security",
    level: 4,
    licenseNumber: `${TAG}-LIC`,
    expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });

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
      address: "1 Test Way",
      defaultPayRate: "30.00",
      defaultBillRate: "55.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // The manager covers this site.
  await db.execute(
    sql`INSERT INTO site_managers (site_id, user_id, assigned_by) VALUES (${ctx.siteId}::uuid, ${ctx.managerId}::uuid, ${ctx.adminId}::uuid)`,
  );

  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.officerToken = signToken({ userId: ctx.officerId, email: `${TAG}-officer@example.test`, role: "employee" });
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.managerId, ctx.officerId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM site_managers WHERE user_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM licenses WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

beforeEach(() => {
  mockedSendPush.mockClear();
});

describe("POST /shifts — notifies the site's managers", () => {
  it("pushes a 'site_shift_created' notice to the site's managers when an admin posts a shift", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.adminToken))
      .send({
        title: `${TAG}-shift`,
        siteId: ctx.siteId,
        startTime: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
        payRate: "30.00",
        billRate: "55.00",
        requiredLicenseLevel: 2,
        headcount: 1,
      });
    expect(res.status).toBe(201);
    const recipients = recipientsForType("site_shift_created");
    expect(recipients).not.toBeNull();
    expect(recipients).toContain(ctx.managerId);
  });
});

describe("POST /shifts/:id/claim — notifies the site's managers", () => {
  it("includes the site's managers among the claim-approval recipients", async () => {
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

    const res = await request(app)
      .post(`/api/shifts/${shift.id}/claim`)
      .set(authed(ctx.officerToken))
      .send({});
    expect(res.status).toBe(201);
    const recipients = recipientsForType("shift_claim_request");
    expect(recipients).not.toBeNull();
    expect(recipients).toContain(ctx.managerId);
  });
});
