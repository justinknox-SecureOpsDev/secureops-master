import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import {
  db,
  usersTable,
  chatRoomsTable,
  chatMessagesTable,
  chatRoomMembershipsTable,
  licensesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  siteManagersTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Exercises the core room-authorization logic in routes/chat.ts
// (resolveRoomMembers / isAuthorizedForRoom) across every room type, the
// surfaces that depend on it (GET /chat/rooms visibility, GET/POST
// messages), and the admin-oversight invariant (admins join non-direct
// rooms but never DMs they aren't part of).
//
// All rows are tagged so cleanup scopes precisely and never trashes seed
// data, mirroring chatUnreadCounts.test.ts.
const TAG = `chat-acl-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// Every test here makes several sequential /chat/rooms list calls (and the
// first one also triggers per-site channel seeding). Each finishes in <1s in
// isolation, but under the full parallel `pnpm -r run test` gate — and the
// release-validation harness, which runs that gate concurrently with
// a11y/typecheck/front-door — any of them can be starved past the default
// 30s. File-wide contention headroom, not a sign any single test is slow.
vi.setConfig({ testTimeout: 180_000 });

type Ctx = {
  adminId: string;
  // Officer holding an unexpired L3 license (covers L2 + L3 rooms/sites).
  officerL3Id: string;
  // Officer holding an unexpired L2 license only.
  officerL2Id: string;
  // Officer whose only license is expired (must be treated as level 0).
  officerExpiredId: string;
  // Officer with no license at all.
  officerNoneId: string;
  // Officer whose last shift at siteL3 ended 3 days ago — inside the lookback
  // window, so still crew. Holds no license, proving access is roster-driven.
  officerRecentId: string;
  // Site manager assigned to siteL3 (holds no shifts of their own).
  siteManagerId: string;

  adminToken: string;
  officerL3Token: string;
  officerL2Token: string;
  officerExpiredToken: string;
  officerNoneToken: string;
  officerRecentToken: string;
  siteManagerToken: string;

  clientId: string;
  // Site the L3 officer is rostered at (and the expired officer worked at
  // 45 days ago, outside the site-channel lookback window).
  siteL3Id: string;
  // Site nobody is rostered at.
  siteNoShiftsId: string;
};
const ctx = {} as Ctx;

type TestRole = "admin" | "employee" | "site_manager";

async function makeUser(role: TestRole, suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      // Epoch watermark so JWT iat (whole-second) is never < tokensValidAfter.
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function tokenFor(userId: string, role: TestRole, suffix: string): string {
  return signToken({ userId, email: `${TAG}-${suffix}@example.test`, role });
}

function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function addLicense(employeeId: string, level: number, expiryDate: string): Promise<void> {
  await db.insert(licensesTable).values({
    employeeId,
    type: "tx-security",
    level,
    licenseNumber: `${TAG}-${employeeId.slice(0, 6)}-${level}`,
    expiryDate,
  });
}

function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

async function makeRoom(values: {
  name: string;
  type: string;
  licenseLevel?: number;
  siteId?: string;
  directKey?: string;
}): Promise<string> {
  const [row] = await db
    .insert(chatRoomsTable)
    .values({
      name: values.name,
      type: values.type,
      ...(values.licenseLevel != null ? { licenseLevel: values.licenseLevel } : {}),
      ...(values.siteId ? { siteId: values.siteId } : {}),
      ...(values.directKey ? { directKey: values.directKey } : {}),
    })
    .returning({ id: chatRoomsTable.id });
  return row.id;
}

async function postMessage(roomId: string, userId: string, content: string): Promise<void> {
  await db.insert(chatMessagesTable).values({ roomId, userId, content });
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerL3Id = await makeUser("employee", "l3");
  ctx.officerL2Id = await makeUser("employee", "l2");
  ctx.officerExpiredId = await makeUser("employee", "exp");
  ctx.officerNoneId = await makeUser("employee", "none");
  ctx.officerRecentId = await makeUser("employee", "recent");
  ctx.siteManagerId = await makeUser("site_manager", "sitemgr");

  ctx.adminToken = tokenFor(ctx.adminId, "admin", "admin");
  ctx.officerL3Token = tokenFor(ctx.officerL3Id, "employee", "l3");
  ctx.officerL2Token = tokenFor(ctx.officerL2Id, "employee", "l2");
  ctx.officerExpiredToken = tokenFor(ctx.officerExpiredId, "employee", "exp");
  ctx.officerNoneToken = tokenFor(ctx.officerNoneId, "employee", "none");
  ctx.officerRecentToken = tokenFor(ctx.officerRecentId, "employee", "recent");
  ctx.siteManagerToken = tokenFor(ctx.siteManagerId, "site_manager", "sitemgr");

  const future = isoDateOffset(365);
  const past = isoDateOffset(-30);
  await addLicense(ctx.officerL3Id, 3, future);
  await addLicense(ctx.officerL2Id, 2, future);
  // Expired L4 — high level but in the past, so it must not count.
  await addLicense(ctx.officerExpiredId, 4, past);

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [siteL3] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site-l3` })
    .returning({ id: sitesTable.id });
  ctx.siteL3Id = siteL3.id;

  const [siteNoShifts] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site-noshifts` })
    .returning({ id: sitesTable.id });
  ctx.siteNoShiftsId = siteNoShifts.id;

  // Site channel access is roster-based, so the fixture needs both an
  // upcoming shift (its officer is in) and one that finished outside the
  // 30-day lookback (its officer has aged out).
  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const oldStart = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const oldEnd = new Date(oldStart.getTime() + 4 * 60 * 60 * 1000);
  const recentStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const recentEnd = new Date(recentStart.getTime() + 4 * 60 * 60 * 1000);
  const [upcoming, stale, recent] = await db.insert(shiftsTable).values([
    { title: `${TAG}-shift-upcoming`, siteId: ctx.siteL3Id, startTime: start, endTime: end, requiredLicenseLevel: 3 },
    { title: `${TAG}-shift-stale`, siteId: ctx.siteL3Id, startTime: oldStart, endTime: oldEnd, requiredLicenseLevel: 3 },
    { title: `${TAG}-shift-recent`, siteId: ctx.siteL3Id, startTime: recentStart, endTime: recentEnd, requiredLicenseLevel: 1 },
  ]).returning({ id: shiftsTable.id });

  await db.insert(shiftAssignmentsTable).values([
    // Rostered for an upcoming shift here → in the site channel.
    { shiftId: upcoming.id, employeeId: ctx.officerL3Id, status: "accepted" },
    // Last worked here 45 days ago → aged out of the site channel.
    { shiftId: stale.id, employeeId: ctx.officerExpiredId, status: "accepted" },
    // Claimed the upcoming shift but not yet approved → still out.
    { shiftId: upcoming.id, employeeId: ctx.officerNoneId, status: "pending_approval" },
    // Worked here 3 days ago → inside the 30-day lookback, still crew.
    { shiftId: recent.id, employeeId: ctx.officerRecentId, status: "accepted" },
  ]);

  await db.insert(siteManagersTable).values({ siteId: ctx.siteL3Id, userId: ctx.siteManagerId });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  const ids = [
    ctx.adminId,
    ctx.officerL3Id,
    ctx.officerL2Id,
    ctx.officerExpiredId,
    ctx.officerNoneId,
    ctx.officerRecentId,
    ctx.siteManagerId,
  ].filter(Boolean);
  for (const id of ids) {
    await db.execute(sql`DELETE FROM chat_rooms WHERE direct_key LIKE ${"%" + id + "%"}`);
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Pool closed by globalTeardown.
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

type RoomRow = { id: string; type: string };

async function listRoomIds(token: string): Promise<Set<string>> {
  const res = await request(app).get("/api/chat/rooms").set(authed(token));
  expect(res.status).toBe(200);
  return new Set((res.body as RoomRow[]).map((r) => r.id));
}

async function getMessagesStatus(token: string, roomId: string): Promise<number> {
  const res = await request(app).get(`/api/chat/rooms/${roomId}/messages`).set(authed(token));
  return res.status;
}

async function postMessageStatus(token: string, roomId: string, content = "hi"): Promise<number> {
  const res = await request(app)
    .post(`/api/chat/rooms/${roomId}/messages`)
    .set(authed(token))
    .send({ content });
  return res.status;
}

describe("GET /chat/rooms — visibility by room type", () => {
  it("announcements is visible to every authenticated user", async () => {
    const id = await makeRoom({ name: `${TAG}-announcements`, type: "announcements" });
    for (const token of [
      ctx.adminToken,
      ctx.officerL3Token,
      ctx.officerL2Token,
      ctx.officerNoneToken,
    ]) {
      expect(await listRoomIds(token)).toContain(id);
    }
  });

  it("ops is visible to admins only", async () => {
    const id = await makeRoom({ name: `${TAG}-ops`, type: "ops" });
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    expect(await listRoomIds(ctx.officerL3Token)).not.toContain(id);
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
  });

  it("license_level room includes officers at/above the level and excludes under-qualified", async () => {
    const id = await makeRoom({ name: `${TAG}-license-l3`, type: "license_level", licenseLevel: 3 });
    // Admin always included; L3 officer qualifies.
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    expect(await listRoomIds(ctx.officerL3Token)).toContain(id);
    // L2 officer is under-qualified; expired-only and no-license excluded.
    expect(await listRoomIds(ctx.officerL2Token)).not.toContain(id);
    expect(await listRoomIds(ctx.officerExpiredToken)).not.toContain(id);
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
  });

  it("site room is visible only to officers rostered at that site (plus its managers and admins)", async () => {
    const id = await makeRoom({ name: `${TAG}-site-l3-room`, type: "site", siteId: ctx.siteL3Id });
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    // Accepted assignment to an upcoming shift here.
    expect(await listRoomIds(ctx.officerL3Token)).toContain(id);
    // Finished a shift here 3 days ago — inside the lookback window, and in
    // despite holding no licence at all.
    expect(await listRoomIds(ctx.officerRecentToken)).toContain(id);
    // Manages this site, so is in even holding no shift of their own.
    expect(await listRoomIds(ctx.siteManagerToken)).toContain(id);
    // Licensed but never rostered here — licence level must not grant access,
    // otherwise the channel goes out to most of the company.
    expect(await listRoomIds(ctx.officerL2Token)).not.toContain(id);
    // Last worked here 45 days ago → outside the 30-day lookback.
    expect(await listRoomIds(ctx.officerExpiredToken)).not.toContain(id);
    // Claim at this site is still pending approval → not yet crew.
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
  });

  it("site room denies reading and posting to officers not rostered there", async () => {
    const id = await makeRoom({ name: `${TAG}-site-l3-rest`, type: "site", siteId: ctx.siteL3Id });
    // Hiding the room from the list is not enough — the message endpoints
    // must refuse a caller who guesses or keeps a stale room id.
    expect(await getMessagesStatus(ctx.officerL2Token, id)).toBe(403);
    expect(await postMessageStatus(ctx.officerL2Token, id)).toBe(403);
    // Aged out and pending-claim callers are refused the same way.
    expect(await getMessagesStatus(ctx.officerExpiredToken, id)).toBe(403);
    expect(await getMessagesStatus(ctx.officerNoneToken, id)).toBe(403);
    // The rostered crew and the site's manager still get through.
    expect(await getMessagesStatus(ctx.officerL3Token, id)).toBe(200);
    expect(await postMessageStatus(ctx.officerL3Token, id)).toBe(201);
    expect(await getMessagesStatus(ctx.siteManagerToken, id)).toBe(200);
  });

  it("site room with nobody rostered is admins-only", async () => {
    const id = await makeRoom({ name: `${TAG}-site-noshifts-room`, type: "site", siteId: ctx.siteNoShiftsId });
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    for (const token of [
      ctx.officerL3Token,
      ctx.officerL2Token,
      ctx.officerNoneToken,
      ctx.siteManagerToken,
    ]) {
      expect(await listRoomIds(token)).not.toContain(id);
    }
  });

  it("city room is visible to explicit members and admins, not to non-members", async () => {
    const id = await makeRoom({ name: `${TAG}-city`, type: "city" });
    await db.insert(chatRoomMembershipsTable).values({
      roomId: id,
      userId: ctx.officerL2Id,
      status: "active",
    });
    expect(await listRoomIds(ctx.officerL2Token)).toContain(id);
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
  });

  it("elite room is hidden from non-members but visible to members and admins", async () => {
    const id = await makeRoom({ name: `${TAG}-elite`, type: "elite" });
    await db.insert(chatRoomMembershipsTable).values({
      roomId: id,
      userId: ctx.officerL3Id,
      status: "active",
    });
    expect(await listRoomIds(ctx.officerL3Token)).toContain(id);
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    expect(await listRoomIds(ctx.officerL2Token)).not.toContain(id);
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
  });

  it("direct room is visible only to its two participants", async () => {
    const id = await makeRoom({
      name: `${TAG}-dm`,
      type: "direct",
      directKey: directKeyFor(ctx.officerL2Id, ctx.officerL3Id),
    });
    expect(await listRoomIds(ctx.officerL2Token)).toContain(id);
    expect(await listRoomIds(ctx.officerL3Token)).toContain(id);
    // A third officer must not see it.
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
  });
});

describe("elite room message access (403 for non-members)", () => {
  it("non-member is denied GET and POST messages; member is allowed", async () => {
    const id = await makeRoom({ name: `${TAG}-elite-msgs`, type: "elite" });
    await db.insert(chatRoomMembershipsTable).values({
      roomId: id,
      userId: ctx.officerL3Id,
      status: "active",
    });
    await postMessage(id, ctx.adminId, "elite intel");

    // Non-member officer: both reads and writes blocked.
    expect(await getMessagesStatus(ctx.officerL2Token, id)).toBe(403);
    expect(await postMessageStatus(ctx.officerL2Token, id)).toBe(403);

    // Member officer: read OK, post OK.
    expect(await getMessagesStatus(ctx.officerL3Token, id)).toBe(200);
    expect(await postMessageStatus(ctx.officerL3Token, id)).toBe(201);
  });
});

describe("admin oversight invariant", () => {
  it("admin can read/post in non-direct rooms even without explicit membership", async () => {
    const id = await makeRoom({ name: `${TAG}-elite-admin`, type: "elite" });
    // No admin membership row exists; admin still passes via role.
    expect(await getMessagesStatus(ctx.adminToken, id)).toBe(200);
    expect(await postMessageStatus(ctx.adminToken, id)).toBe(201);
  });

  it("admin is NOT added to DMs they aren't part of", async () => {
    const id = await makeRoom({
      name: `${TAG}-dm-private`,
      type: "direct",
      directKey: directKeyFor(ctx.officerNoneId, ctx.officerExpiredId),
    });
    await postMessage(id, ctx.officerNoneId, "private");

    // Not listed for the admin.
    expect(await listRoomIds(ctx.adminToken)).not.toContain(id);
    // And message access is forbidden despite admin role.
    expect(await getMessagesStatus(ctx.adminToken, id)).toBe(403);
    expect(await postMessageStatus(ctx.adminToken, id)).toBe(403);
  });
});
