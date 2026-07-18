import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";

// The shift create + claim notification fan-outs are the surfaces under test.
// Mock push + sms so the routes' recipient computation is observable without
// touching Expo/Twilio. Only sendSmsToUsers/sendSmsToPhoneNumber are statically
// imported across the app, so both must exist on the mock to keep app load
// working.
vi.mock("../lib/push", () => ({
  sendPushToUsers: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/sms", () => ({
  sendSmsToUsers: vi.fn(() => Promise.resolve({ sent: 0, skipped: 0, failed: 0 })),
  sendSmsToPhoneNumber: vi.fn(() => Promise.resolve({ sent: 0, skipped: 0, failed: 0 })),
}));

import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  siteManagersTable,
} from "@workspace/db";
import app from "../app";
import { processInboundShift } from "../routes/schedulerWebhook";
import { signToken } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";
import { sendSmsToUsers } from "../lib/sms";

const mockedPush = vi.mocked(sendPushToUsers);
const mockedSms = vi.mocked(sendSmsToUsers);

const TAG = `mgr-notify-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  managerAId: string;
  managerBId: string;
  claimOfficerId: string;
  adminToken: string;
  claimOfficerToken: string;
  clientId: string;
  siteAId: string;
  claimShiftId: string;
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

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.managerAId = await makeUser("site_manager", "managerA");
  ctx.managerBId = await makeUser("site_manager", "managerB");
  ctx.claimOfficerId = await makeUser("employee", "officer");

  await db.insert(employeesTable).values([
    { userId: ctx.managerAId, position: "officer", skills: [] },
    // managerB is a site_manager (a worker) NOT assigned to siteA — used to
    // prove site managers receive the same worker broadcast as employees.
    { userId: ctx.managerBId, position: "officer", skills: [] },
    // Support staff: effective level 1 with no licence, so they can claim the
    // level-1 fixture shift below.
    { userId: ctx.claimOfficerId, position: "support_staff", skills: [] },
  ]);

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-siteA`,
      address: "1 Test Way",
      defaultPayRate: "30.00",
      defaultBillRate: "55.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteAId = site.id;

  await db.insert(siteManagersTable).values({ siteId: ctx.siteAId, userId: ctx.managerAId });

  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-claimable`,
      siteId: ctx.siteAId,
      startTime: start,
      endTime: end,
      payRate: "30.00",
      billRate: "55.00",
      requiredLicenseLevel: 1,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.claimShiftId = shift.id;

  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.claimOfficerToken = signToken({ userId: ctx.claimOfficerId, email: `${TAG}-officer@example.test`, role: "employee" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shift_assignments WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM site_managers WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

beforeEach(() => {
  mockedPush.mockClear();
  mockedSms.mockClear();
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Locate the push call whose notification carries the given data.type. */
function pushCallByType(type: string): { recipients: string[]; notification: Record<string, unknown> } | null {
  const call = mockedPush.mock.calls.find(
    (c) => (c[1] as { data?: { type?: string } } | undefined)?.data?.type === type,
  );
  if (!call) return null;
  return { recipients: call[0] as string[], notification: call[1] as Record<string, unknown> };
}

describe("POST /shifts — new-shift site-manager notification", () => {
  it("notifies the site's assigned managers (push + sms) on create", async () => {
    const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.adminToken))
      .send({
        title: `${TAG}-fresh`,
        siteId: ctx.siteAId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        payRate: "30.00",
        billRate: "55.00",
        requiredLicenseLevel: 2,
        headcount: 1,
      });
    expect(res.status).toBe(201);

    const sitePush = pushCallByType("site_shift_created");
    expect(sitePush).not.toBeNull();
    // Exactly the one manager assigned to this site.
    expect(sitePush!.recipients).toEqual([ctx.managerAId]);

    // SMS mirrors the push to the same managers.
    const smsCall = mockedSms.mock.calls.find((c) => (c[0] as string[]).includes(ctx.managerAId));
    expect(smsCall).toBeTruthy();
  });
});

describe("POST /shifts/:id/claim — approver notification dedupe", () => {
  it("pages all admins PLUS the site's managers, with no duplicate recipients", async () => {
    const res = await request(app)
      .post(`/api/shifts/${ctx.claimShiftId}/claim`)
      .set(authed(ctx.claimOfficerToken));
    expect(res.status).toBe(201);

    const claimPush = pushCallByType("shift_claim_request");
    expect(claimPush).not.toBeNull();
    const recipients = claimPush!.recipients;
    // The site's manager is paged.
    expect(recipients).toContain(ctx.managerAId);
    // Every admin is paged (our fixture admin must be present).
    expect(recipients).toContain(ctx.adminId);
    // Deduped: no recipient id appears twice.
    expect(recipients.length).toBe(new Set(recipients).size);
  });
});

describe("POST /shifts — site managers receive the worker broadcast", () => {
  it("pages site managers (incl. this site's own) in the worker broadcast, AND the manager notice", async () => {
    const start = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.adminToken))
      .send({
        title: `${TAG}-worker-bcast`,
        siteId: ctx.siteAId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        payRate: "30.00",
        billRate: "55.00",
        requiredLicenseLevel: 2,
        headcount: 1,
      });
    expect(res.status).toBe(201);

    const available = pushCallByType("shift_available");
    expect(available).not.toBeNull();
    // A site_manager who is a worker (and not THIS site's manager) is paged
    // exactly like any employee — the "same employee notifications".
    expect(available!.recipients).toContain(ctx.managerBId);
    // This site's OWN manager ALSO receives the worker broadcast (the "same
    // employee notifications as well") — no exclusion.
    expect(available!.recipients).toContain(ctx.managerAId);

    // ...and the same manager additionally gets the manager-specific notice, so
    // they are notified BOTH ways for a shift at their site.
    const sitePush = pushCallByType("site_shift_created");
    expect(sitePush).not.toBeNull();
    expect(sitePush!.recipients).toContain(ctx.managerAId);
  });
});

describe("processInboundShift — scheduler-created shift notifications", () => {
  it("notifies the site's managers AND broadcasts to eligible workers on create", async () => {
    const start = new Date(Date.now() + 120 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const result = await processInboundShift({
      id: `${TAG}-ext-create`,
      title: `${TAG}-sched-create`,
      siteName: `${TAG}-siteA`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      requiredLicenseLevel: 2,
      headcount: 1,
      updatedAt: new Date().toISOString(),
    });
    expect(result.action).toBe("created");

    // The site's manager gets the manager-specific notice...
    const sitePush = pushCallByType("site_shift_created");
    expect(sitePush).not.toBeNull();
    expect(sitePush!.recipients).toContain(ctx.managerAId);

    // ...and eligible workers get the "shift available" broadcast — proving
    // scheduler-sourced shifts notify the same people as the manual route. This
    // includes an unrelated site_manager (managerB) AND this site's own manager
    // (managerA), who therefore gets BOTH notifications.
    const available = pushCallByType("shift_available");
    expect(available).not.toBeNull();
    expect(available!.recipients).toContain(ctx.managerBId);
    expect(available!.recipients).toContain(ctx.managerAId);
  });
});
