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
  chatRoomReadsTable,
  chatRoomMembershipsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// All test rows are tagged so cleanup can scope precisely and a parallel
// or aborted run can't trample real seed data. The tag is embedded in
// user last names / room names.
const TAG = `chat-unread-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  // Officer A is the primary caller in most assertions.
  officerAId: string;
  // Officer B is a counterparty (sends DMs) and a non-member for ACL checks.
  officerBId: string;
  // Officer C is a fresh DM counterparty so direct_key stays unique.
  officerCId: string;
  adminToken: string;
  officerAToken: string;
  officerBToken: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee"): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${role}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: role[0].toUpperCase() + role.slice(1),
      lastName: TAG,
      role,
      status: "active",
      // Epoch watermark so JWT iat (floored to whole seconds) is never
      // accidentally < tokensValidAfter (ms-precision insert timestamp).
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin");
  ctx.officerAId = await makeUser("employee");
  ctx.officerBId = await makeUser("employee");
  ctx.officerCId = await makeUser("employee");

  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
  ctx.officerAToken = signToken({
    userId: ctx.officerAId,
    email: `${TAG}-a@example.test`,
    role: "employee",
  });
  ctx.officerBToken = signToken({
    userId: ctx.officerBId,
    email: `${TAG}-b@example.test`,
    role: "employee",
  });
});

afterAll(async () => {
  // chat_messages / chat_room_reads / chat_room_memberships cascade off
  // either chat_rooms or users delete, but we delete rooms explicitly to
  // keep the row count bounded, then the tagged users.
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  // Direct rooms are named without the TAG; remove by direct_key referencing
  // any of our officer ids.
  const ids = [ctx.adminId, ctx.officerAId, ctx.officerBId].filter(Boolean);
  if (ids.length > 0) {
    for (const id of ids) {
      await db.execute(
        sql`DELETE FROM chat_rooms WHERE direct_key LIKE ${"%" + id + "%"}`,
      );
    }
  }
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Pool closed by globalTeardown.
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Insert a chat room and return its id.
async function makeRoom(values: {
  name: string;
  type: string;
  directKey?: string;
}): Promise<string> {
  const [row] = await db
    .insert(chatRoomsTable)
    .values({
      name: values.name,
      type: values.type,
      ...(values.directKey ? { directKey: values.directKey } : {}),
    })
    .returning({ id: chatRoomsTable.id });
  return row.id;
}

// Insert a message into a room at an optional explicit timestamp.
async function postMessage(
  roomId: string,
  userId: string,
  content: string,
  createdAt?: Date,
): Promise<void> {
  await db.insert(chatMessagesTable).values({
    roomId,
    userId,
    content,
    ...(createdAt ? { createdAt } : {}),
  });
}

// Set the caller's last-read watermark directly (bypassing the route) at a
// specific instant so we can place messages before/after deterministically.
async function setReadWatermark(
  roomId: string,
  userId: string,
  at: Date,
): Promise<void> {
  await db
    .insert(chatRoomReadsTable)
    .values({ roomId, userId, lastReadAt: at })
    .onConflictDoUpdate({
      target: [chatRoomReadsTable.roomId, chatRoomReadsTable.userId],
      set: { lastReadAt: at },
    });
}

type UnreadRow = { roomId: string; otherUserId: string; unreadCount: number };

async function getUnread(
  token: string,
  scope?: "all",
): Promise<UnreadRow[]> {
  const res = await request(app)
    .get(`/api/chat/unread-counts${scope ? `?scope=${scope}` : ""}`)
    .set(authed(token));
  expect(res.status).toBe(200);
  return res.body as UnreadRow[];
}

function findRoom(rows: UnreadRow[], roomId: string): UnreadRow | undefined {
  return rows.find((r) => r.roomId === roomId);
}

describe("GET /chat/unread-counts — default (direct-only) scope", () => {
  it("returns direct rooms only, excludes own messages and pre-watermark messages", async () => {
    const dmId = await makeRoom({
      name: `dm-${TAG}-1`,
      type: "direct",
      directKey: directKeyFor(ctx.officerAId, ctx.officerBId),
    });

    const base = Date.now();
    // Two messages from B before A's watermark — should NOT count.
    await postMessage(dmId, ctx.officerBId, "old 1", new Date(base - 60_000));
    await postMessage(dmId, ctx.officerBId, "old 2", new Date(base - 50_000));
    // A's watermark sits between the old and new batches.
    await setReadWatermark(dmId, ctx.officerAId, new Date(base - 40_000));
    // Two messages from B after the watermark — SHOULD count (=2).
    await postMessage(dmId, ctx.officerBId, "new 1", new Date(base - 30_000));
    await postMessage(dmId, ctx.officerBId, "new 2", new Date(base - 20_000));
    // A's own message after the watermark — must NOT count.
    await postMessage(dmId, ctx.officerAId, "mine", new Date(base - 10_000));

    const rows = await getUnread(ctx.officerAToken);
    const dm = findRoom(rows, dmId);
    expect(dm, "direct room appears in default scope").toBeDefined();
    expect(dm!.unreadCount).toBe(2);
    // Direct rows carry the other participant's id for the Personnel grid.
    expect(dm!.otherUserId).toBe(ctx.officerBId);
  });

  it("omits non-direct rooms even when they have unread messages", async () => {
    // Announcements room is visible to everyone, but the default scope is
    // direct-only, so it must not appear without ?scope=all.
    const annId = await makeRoom({
      name: `ann-${TAG}-default`,
      type: "announcements",
    });
    await postMessage(annId, ctx.adminId, "hello all");

    const rows = await getUnread(ctx.officerAToken);
    expect(findRoom(rows, annId), "announcements hidden in default scope").toBeUndefined();
  });

  it("omits rooms with zero unread (missing entry == zero)", async () => {
    const dmId = await makeRoom({
      name: `dm-${TAG}-zero`,
      type: "direct",
      directKey: directKeyFor(ctx.officerAId, ctx.adminId),
    });
    // Only A's own message exists — net unread for A is zero.
    await postMessage(dmId, ctx.officerAId, "just me");

    const rows = await getUnread(ctx.officerAToken);
    expect(findRoom(rows, dmId), "zero-unread room omitted").toBeUndefined();
  });
});

describe("GET /chat/unread-counts?scope=all — non-direct ACLs", () => {
  it("includes non-direct rooms the caller can access", async () => {
    const annId = await makeRoom({
      name: `ann-${TAG}-all`,
      type: "announcements",
    });
    await postMessage(annId, ctx.adminId, "broadcast");

    const rows = await getUnread(ctx.officerAToken, "all");
    const ann = findRoom(rows, annId);
    expect(ann, "announcements appears under scope=all").toBeDefined();
    expect(ann!.unreadCount).toBe(1);
  });

  it("honors city-room membership (member sees it, non-member does not)", async () => {
    const cityId = await makeRoom({ name: `city-${TAG}`, type: "city" });
    // A is an active member; B is not a member at all.
    await db.insert(chatRoomMembershipsTable).values({
      roomId: cityId,
      userId: ctx.officerAId,
      status: "active",
    });
    await postMessage(cityId, ctx.adminId, "city update");

    const aRows = await getUnread(ctx.officerAToken, "all");
    expect(findRoom(aRows, cityId), "member sees city room").toBeDefined();
    expect(findRoom(aRows, cityId)!.unreadCount).toBe(1);

    const bRows = await getUnread(ctx.officerBToken, "all");
    expect(
      findRoom(bRows, cityId),
      "non-member must not see city room count",
    ).toBeUndefined();
  });

  it("honors elite-room membership (member sees it, non-member does not)", async () => {
    const eliteId = await makeRoom({ name: `elite-${TAG}`, type: "elite" });
    // A is invited (allowed to read while invited); B is not a member.
    await db.insert(chatRoomMembershipsTable).values({
      roomId: eliteId,
      userId: ctx.officerAId,
      status: "invited",
    });
    await postMessage(eliteId, ctx.adminId, "elite intel");

    const aRows = await getUnread(ctx.officerAToken, "all");
    expect(findRoom(aRows, eliteId), "invited member sees elite room").toBeDefined();
    expect(findRoom(aRows, eliteId)!.unreadCount).toBe(1);

    const bRows = await getUnread(ctx.officerBToken, "all");
    expect(
      findRoom(bRows, eliteId),
      "non-member must not see elite room count",
    ).toBeUndefined();
  });

  it("still excludes own messages and pre-watermark messages under scope=all", async () => {
    const cityId = await makeRoom({ name: `city-${TAG}-wm`, type: "city" });
    await db.insert(chatRoomMembershipsTable).values({
      roomId: cityId,
      userId: ctx.officerAId,
      status: "active",
    });

    const base = Date.now();
    await postMessage(cityId, ctx.adminId, "old", new Date(base - 60_000));
    await setReadWatermark(cityId, ctx.officerAId, new Date(base - 40_000));
    await postMessage(cityId, ctx.adminId, "new 1", new Date(base - 30_000));
    await postMessage(cityId, ctx.adminId, "new 2", new Date(base - 20_000));
    await postMessage(cityId, ctx.officerAId, "mine", new Date(base - 10_000));

    const rows = await getUnread(ctx.officerAToken, "all");
    const city = findRoom(rows, cityId);
    expect(city, "city room present under scope=all").toBeDefined();
    expect(city!.unreadCount).toBe(2);
  });
});

describe("POST /chat/rooms/:id/read", () => {
  it("zeroes the room's unread count for the caller", async () => {
    const dmId = await makeRoom({
      name: `dm-${TAG}-read`,
      type: "direct",
      directKey: directKeyFor(ctx.officerAId, ctx.officerCId),
    });
    await postMessage(dmId, ctx.officerCId, "ping 1");
    await postMessage(dmId, ctx.officerCId, "ping 2");

    const before = await getUnread(ctx.officerAToken);
    expect(findRoom(before, dmId)?.unreadCount).toBe(2);

    const readRes = await request(app)
      .post(`/api/chat/rooms/${dmId}/read`)
      .set(authed(ctx.officerAToken));
    expect(readRes.status).toBe(200);
    expect(readRes.body.ok).toBe(true);

    const after = await getUnread(ctx.officerAToken);
    expect(
      findRoom(after, dmId),
      "room drops out of unread list after read",
    ).toBeUndefined();
  });

  it("rejects marking a room the caller cannot access (403)", async () => {
    // Elite room with no membership for B → B cannot mark it read.
    const eliteId = await makeRoom({ name: `elite-${TAG}-403`, type: "elite" });
    await postMessage(eliteId, ctx.adminId, "secret");

    const res = await request(app)
      .post(`/api/chat/rooms/${eliteId}/read`)
      .set(authed(ctx.officerBToken));
    expect(res.status).toBe(403);
  });
});
