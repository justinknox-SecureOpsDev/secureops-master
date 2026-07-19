import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  adminToken: string;
  officerL3Token: string;
  officerL2Token: string;
  officerExpiredToken: string;
  officerNoneToken: string;

  clientId: string;
  // Site whose lowest shift requires L3.
  siteL3Id: string;
  // Site with no shifts → resolver falls back to required level 2.
  siteNoShiftsId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
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

function tokenFor(userId: string, role: "admin" | "employee", suffix: string): string {
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

  ctx.adminToken = tokenFor(ctx.adminId, "admin", "admin");
  ctx.officerL3Token = tokenFor(ctx.officerL3Id, "employee", "l3");
  ctx.officerL2Token = tokenFor(ctx.officerL2Id, "employee", "l2");
  ctx.officerExpiredToken = tokenFor(ctx.officerExpiredId, "employee", "exp");
  ctx.officerNoneToken = tokenFor(ctx.officerNoneId, "employee", "none");

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

  // Two shifts at siteL3 (one L4, one L3); resolver gates on the MIN = 3.
  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  await db.insert(shiftsTable).values([
    { title: `${TAG}-shift-l4`, siteId: ctx.siteL3Id, startTime: start, endTime: end, requiredLicenseLevel: 4 },
    { title: `${TAG}-shift-l3`, siteId: ctx.siteL3Id, startTime: start, endTime: end, requiredLicenseLevel: 3 },
  ]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  const ids = [
    ctx.adminId,
    ctx.officerL3Id,
    ctx.officerL2Id,
    ctx.officerExpiredId,
    ctx.officerNoneId,
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
  // The first two tests in this file absorb the suite's one-time costs (first
  // /chat/rooms request triggers per-site channel seeding, plus several
  // sequential list calls). They pass comfortably in isolation but can time
  // out under the full parallel `pnpm -r run test` gate when every package's
  // suite competes for CPU/DB — and the release-validation harness runs the
  // test gate concurrently with a11y/typecheck/front-door, which starved even
  // a 60s budget. Generous timeout, purely contention headroom.
  const FIRST_TESTS_TIMEOUT_MS = 180_000;

  it(
    "announcements is visible to every authenticated user",
    async () => {
      const id = await makeRoom({ name: `${TAG}-announcements`, type: "announcements" });
      for (const token of [
        ctx.adminToken,
        ctx.officerL3Token,
        ctx.officerL2Token,
        ctx.officerNoneToken,
      ]) {
        expect(await listRoomIds(token)).toContain(id);
      }
    },
    FIRST_TESTS_TIMEOUT_MS,
  );

  it(
    "ops is visible to admins only",
    async () => {
      const id = await makeRoom({ name: `${TAG}-ops`, type: "ops" });
      expect(await listRoomIds(ctx.adminToken)).toContain(id);
      expect(await listRoomIds(ctx.officerL3Token)).not.toContain(id);
      expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
    },
    FIRST_TESTS_TIMEOUT_MS,
  );

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

  it("site room gates on the site's lowest shift level (L3 here)", async () => {
    const id = await makeRoom({ name: `${TAG}-site-l3-room`, type: "site", siteId: ctx.siteL3Id });
    expect(await listRoomIds(ctx.adminToken)).toContain(id);
    expect(await listRoomIds(ctx.officerL3Token)).toContain(id);
    expect(await listRoomIds(ctx.officerL2Token)).not.toContain(id);
    expect(await listRoomIds(ctx.officerExpiredToken)).not.toContain(id);
  });

  it("site room with no shifts falls back to required level 2", async () => {
    const id = await makeRoom({ name: `${TAG}-site-noshifts-room`, type: "site", siteId: ctx.siteNoShiftsId });
    // L2 officer now qualifies via the level-2 fallback; no-license still out.
    expect(await listRoomIds(ctx.officerL2Token)).toContain(id);
    expect(await listRoomIds(ctx.officerL3Token)).toContain(id);
    expect(await listRoomIds(ctx.officerNoneToken)).not.toContain(id);
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
