import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";

// The SOS fan-out (admins + co-located officers) is the surface under test.
// We mock lib/push so recipient computation is observable without touching
// Expo. lib/sms is left REAL — without a Twilio connection it no-ops, so it
// never reaches the network in tests.
vi.mock("../lib/push", () => ({
  sendPushToUsers: vi.fn(() => Promise.resolve()),
}));

import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";

const mockedSendPush = vi.mocked(sendPushToUsers);

const TAG = `sos-bcast-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  sosOfficerId: string; // clocked in at site A (ad-hoc siteId entry)
  coworkerId: string; // clocked in at site A via a shift (shiftId path)
  otherSiteId: string; // clocked in at site B — must NOT be alerted
  offDutyId: string; // not clocked in — must NOT be alerted
  sosToken: string;
  adminToken: string;
  clientId: string;
  siteAId: string;
  siteBId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string, phone?: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      phoneNumber: phone ?? null,
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function clockIn(employeeId: string, opts: { siteId?: string; shiftId?: string }): Promise<void> {
  await db.insert(timeEntriesTable).values({
    employeeId,
    siteId: opts.siteId ?? null,
    shiftId: opts.shiftId ?? null,
    clockInTime: new Date(Date.now() - 60 * 60 * 1000),
  });
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.sosOfficerId = await makeUser("employee", "sos", "+15125550111");
  ctx.coworkerId = await makeUser("employee", "coworker");
  ctx.otherSiteId = await makeUser("employee", "othersite");
  ctx.offDutyId = await makeUser("employee", "offduty");

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [siteA] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site-A`,
      address: "100 Test Way",
      locationLat: "30.000000",
      locationLng: "-97.000000",
    })
    .returning({ id: sitesTable.id });
  ctx.siteAId = siteA.id;

  const [siteB] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site-B`,
      address: "200 Test Way",
      locationLat: "31.000000",
      locationLng: "-98.000000",
    })
    .returning({ id: sitesTable.id });
  ctx.siteBId = siteB.id;

  // Co-worker is attached to site A through a SHIFT (not the entry's own
  // siteId) — exercises the shift-site resolution branch of the broadcast.
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteAId,
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endTime: new Date(Date.now() + 6 * 60 * 60 * 1000),
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  await clockIn(ctx.sosOfficerId, { siteId: ctx.siteAId });
  await clockIn(ctx.coworkerId, { shiftId: ctx.shiftId });
  await clockIn(ctx.otherSiteId, { siteId: ctx.siteBId });
  // offDuty: no time entry at all.

  ctx.sosToken = signToken({
    userId: ctx.sosOfficerId,
    email: `${TAG}-sos@example.test`,
    role: "employee",
  });
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.sosOfficerId, ctx.coworkerId, ctx.otherSiteId, ctx.offDutyId].filter(Boolean);
  if (ids.length > 0) {
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})`,
    );
    await db.execute(
      sql`DELETE FROM incidents WHERE employee_id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})`,
    );
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

// Return every recipient-id array for push calls whose title matches.
function recipientsForTitle(match: string): string[][] {
  return mockedSendPush.mock.calls
    .filter((call) => {
      const [, payload] = call as [string[], { title?: string }];
      return typeof payload?.title === "string" && payload.title.includes(match);
    })
    .map((call) => call[0]);
}

describe("POST /emergency site-wide broadcast", () => {
  it("alerts admins AND co-workers clocked into the same site, but nobody else", async () => {
    const res = await request(app)
      .post("/api/emergency")
      .set(authed(ctx.sosToken))
      .send({ lat: 30.0001, lng: -97.0001, message: "test SOS" });
    expect(res.status).toBe(201);
    expect(res.body.incident?.severity).toBe("critical");

    // Admin channel fires synchronously-ish; the co-worker broadcast is
    // fire-and-forget, so poll until it lands.
    await vi.waitFor(() => {
      expect(recipientsForTitle("EMERGENCY NEARBY").length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const adminCalls = recipientsForTitle("EMERGENCY ALERT");
    expect(adminCalls.length).toBeGreaterThan(0);
    expect(adminCalls[0]).toContain(ctx.adminId);

    const coworkerCalls = recipientsForTitle("EMERGENCY NEARBY");
    expect(coworkerCalls).toHaveLength(1);
    const recipients = coworkerCalls[0];
    // Shift-site co-worker gets it…
    expect(recipients).toContain(ctx.coworkerId);
    // …but never the SOS officer themself, other-site or off-duty staff.
    expect(recipients).not.toContain(ctx.sosOfficerId);
    expect(recipients).not.toContain(ctx.otherSiteId);
    expect(recipients).not.toContain(ctx.offDutyId);
    // Admins are alerted on the admin channel only — no double-notify.
    expect(recipients).not.toContain(ctx.adminId);
  });

  it("exposes officer contact info on /dispatch/active-incidents for the SOS popup", async () => {
    const res = await request(app)
      .get("/api/dispatch/active-incidents")
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(200);
    const mine = (res.body as Array<Record<string, unknown>>).find(
      (i) => i.employeeId === ctx.sosOfficerId,
    );
    expect(mine).toBeDefined();
    expect(mine!.severity).toBe("critical");
    expect(mine!.employeePhone).toBe("+15125550111");
    expect(mine!.employeeEmail).toBe(`${TAG}-sos@example.test`);
  });
});
