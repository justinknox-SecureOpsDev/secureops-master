import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  chatRoomsTable,
  chatRoomMembershipsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Exercises the chat membership *lifecycle* endpoints in routes/chat.ts that
// drive request-to-join (city) and invite-only (elite/city) access:
//   - POST   /chat/rooms/:id/join-request
//   - GET    /admin/chat/membership-requests
//   - POST   /admin/chat/membership-requests/:id/approve
//   - POST   /admin/chat/membership-requests/:id/deny
//   - POST   /admin/chat/rooms/:id/invite
//   - DELETE /admin/chat/rooms/:id/members/:userId
//
// chatRoomAccess.test.ts already covers *visibility/read/post* authorization;
// this file covers the membership state machine and the admin-only guards.
//
// Rows are tagged so cleanup scopes precisely and never touches seed data,
// mirroring chatRoomAccess.test.ts / chatUnreadCounts.test.ts.
const TAG = `chat-membership-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerAId: string;
  officerBId: string;
  officerCId: string;

  adminToken: string;
  officerAToken: string;
  officerBToken: string;
  officerCToken: string;
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

async function makeRoom(name: string, type: string): Promise<string> {
  const [row] = await db
    .insert(chatRoomsTable)
    .values({ name, type })
    .returning({ id: chatRoomsTable.id });
  return row.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

type RoomRow = { id: string };

async function listRoomIds(token: string): Promise<Set<string>> {
  const res = await request(app).get("/api/chat/rooms").set(authed(token));
  expect(res.status).toBe(200);
  return new Set((res.body as RoomRow[]).map((r) => r.id));
}

async function membershipStatus(roomId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: chatRoomMembershipsTable.status })
    .from(chatRoomMembershipsTable)
    .where(
      and(
        eq(chatRoomMembershipsTable.roomId, roomId),
        eq(chatRoomMembershipsTable.userId, userId),
      ),
    )
    .limit(1);
  return row?.status ?? null;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerAId = await makeUser("employee", "a");
  ctx.officerBId = await makeUser("employee", "b");
  ctx.officerCId = await makeUser("employee", "c");

  ctx.adminToken = tokenFor(ctx.adminId, "admin", "admin");
  ctx.officerAToken = tokenFor(ctx.officerAId, "employee", "a");
  ctx.officerBToken = tokenFor(ctx.officerBId, "employee", "b");
  ctx.officerCToken = tokenFor(ctx.officerCId, "employee", "c");
});

afterAll(async () => {
  // chat_room_memberships cascade-delete with their rooms.
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Pool closed by globalTeardown.
});

describe("POST /chat/rooms/:id/join-request", () => {
  it("officer requesting a city room creates a pending membership (201)", async () => {
    const roomId = await makeRoom(`${TAG}-city-join`, "city");
    const res = await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerAToken));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.userId).toBe(ctx.officerAId);
    expect(res.body.roomId).toBe(roomId);
    expect(await membershipStatus(roomId, ctx.officerAId)).toBe("pending");
  });

  it("a pending request does NOT yet make the city room visible", async () => {
    const roomId = await makeRoom(`${TAG}-city-pending-hidden`, "city");
    await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerAToken))
      .expect(201);
    // Still pending → not an active member → room not listed.
    expect(await listRoomIds(ctx.officerAToken)).not.toContain(roomId);
  });

  it("requesting a non-city room returns 400", async () => {
    const roomId = await makeRoom(`${TAG}-elite-nojoin`, "elite");
    const res = await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerAToken));
    expect(res.status).toBe(400);
    // No membership row should be created.
    expect(await membershipStatus(roomId, ctx.officerAId)).toBeNull();
  });

  it("requesting a non-existent room returns 404", async () => {
    const res = await request(app)
      .post(`/api/chat/rooms/${randomUUID()}/join-request`)
      .set(authed(ctx.officerAToken));
    expect(res.status).toBe(404);
  });

  it("repeat requests are idempotent — returns the existing row (200), no duplicate", async () => {
    const roomId = await makeRoom(`${TAG}-city-idem`, "city");
    const first = await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerBToken));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerBToken));
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe("pending");

    const rows = await db
      .select({ id: chatRoomMembershipsTable.id })
      .from(chatRoomMembershipsTable)
      .where(
        and(
          eq(chatRoomMembershipsTable.roomId, roomId),
          eq(chatRoomMembershipsTable.userId, ctx.officerBId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("requires authentication", async () => {
    const roomId = await makeRoom(`${TAG}-city-noauth`, "city");
    const res = await request(app).post(`/api/chat/rooms/${roomId}/join-request`);
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/chat/membership-requests + approve/deny", () => {
  it("lists pending requests; approve flips to active and the room becomes visible", async () => {
    const roomId = await makeRoom(`${TAG}-city-approve`, "city");
    const reqRes = await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerAToken));
    expect(reqRes.status).toBe(201);
    const membershipId = reqRes.body.id as string;

    // Admin queue surfaces the pending request with joined room/user fields.
    const queue = await request(app)
      .get("/api/admin/chat/membership-requests")
      .set(authed(ctx.adminToken));
    expect(queue.status).toBe(200);
    const entry = (queue.body as Array<{ id: string; roomId: string; userId: string; status: string }>)
      .find((r) => r.id === membershipId);
    expect(entry).toBeTruthy();
    expect(entry!.status).toBe("pending");
    expect(entry!.roomId).toBe(roomId);
    expect(entry!.userId).toBe(ctx.officerAId);

    // Before approval the officer cannot see the room.
    expect(await listRoomIds(ctx.officerAToken)).not.toContain(roomId);

    // Approve.
    const approve = await request(app)
      .post(`/api/admin/chat/membership-requests/${membershipId}/approve`)
      .set(authed(ctx.adminToken));
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("active");

    // Now active → visible.
    expect(await membershipStatus(roomId, ctx.officerAId)).toBe("active");
    expect(await listRoomIds(ctx.officerAToken)).toContain(roomId);

    // And it no longer appears in the pending queue.
    const queueAfter = await request(app)
      .get("/api/admin/chat/membership-requests")
      .set(authed(ctx.adminToken));
    expect((queueAfter.body as Array<{ id: string }>).some((r) => r.id === membershipId)).toBe(false);
  });

  it("deny removes the request row entirely and the room stays hidden", async () => {
    const roomId = await makeRoom(`${TAG}-city-deny`, "city");
    const reqRes = await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerBToken));
    const membershipId = reqRes.body.id as string;

    const deny = await request(app)
      .post(`/api/admin/chat/membership-requests/${membershipId}/deny`)
      .set(authed(ctx.adminToken));
    expect(deny.status).toBe(200);
    expect(deny.body.ok).toBe(true);

    // Row gone, room not visible.
    expect(await membershipStatus(roomId, ctx.officerBId)).toBeNull();
    expect(await listRoomIds(ctx.officerBToken)).not.toContain(roomId);
  });

  it("approve/deny of an unknown request id returns 404", async () => {
    const approve = await request(app)
      .post(`/api/admin/chat/membership-requests/${randomUUID()}/approve`)
      .set(authed(ctx.adminToken));
    expect(approve.status).toBe(404);
    const deny = await request(app)
      .post(`/api/admin/chat/membership-requests/${randomUUID()}/deny`)
      .set(authed(ctx.adminToken));
    expect(deny.status).toBe(404);
  });

  it("rejects non-admin callers (403) and unauthenticated callers (401)", async () => {
    expect(
      (await request(app).get("/api/admin/chat/membership-requests").set(authed(ctx.officerAToken))).status,
    ).toBe(403);
    expect((await request(app).get("/api/admin/chat/membership-requests")).status).toBe(401);

    const fakeId = randomUUID();
    expect(
      (await request(app)
        .post(`/api/admin/chat/membership-requests/${fakeId}/approve`)
        .set(authed(ctx.officerAToken))).status,
    ).toBe(403);
    expect(
      (await request(app)
        .post(`/api/admin/chat/membership-requests/${fakeId}/deny`)
        .set(authed(ctx.officerAToken))).status,
    ).toBe(403);
  });
});

describe("POST /admin/chat/rooms/:id/invite", () => {
  it("invites users to an elite room as active members → they gain access", async () => {
    const roomId = await makeRoom(`${TAG}-elite-invite`, "elite");
    const res = await request(app)
      .post(`/api/admin/chat/rooms/${roomId}/invite`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerAId, ctx.officerBId] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(2);

    expect(await membershipStatus(roomId, ctx.officerAId)).toBe("active");
    expect(await membershipStatus(roomId, ctx.officerBId)).toBe("active");
    expect(await listRoomIds(ctx.officerAToken)).toContain(roomId);
    expect(await listRoomIds(ctx.officerBToken)).toContain(roomId);
    // A non-invited officer stays out.
    expect(await listRoomIds(ctx.officerCToken)).not.toContain(roomId);
  });

  it("invites work for city rooms too, and re-inviting is idempotent (upsert to active)", async () => {
    const roomId = await makeRoom(`${TAG}-city-invite`, "city");
    // First a pending self-request, then admin invite upgrades it to active.
    await request(app)
      .post(`/api/chat/rooms/${roomId}/join-request`)
      .set(authed(ctx.officerCToken))
      .expect(201);
    expect(await membershipStatus(roomId, ctx.officerCId)).toBe("pending");

    const invite = await request(app)
      .post(`/api/admin/chat/rooms/${roomId}/invite`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerCId] });
    expect(invite.status).toBe(200);
    expect(invite.body.added).toBe(1);
    expect(await membershipStatus(roomId, ctx.officerCId)).toBe("active");

    // Re-invite: still active, no duplicate row.
    await request(app)
      .post(`/api/admin/chat/rooms/${roomId}/invite`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerCId] })
      .expect(200);
    const rows = await db
      .select({ id: chatRoomMembershipsTable.id })
      .from(chatRoomMembershipsTable)
      .where(
        and(
          eq(chatRoomMembershipsTable.roomId, roomId),
          eq(chatRoomMembershipsTable.userId, ctx.officerCId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("rejects inviting to non-invitable room types (400)", async () => {
    const roomId = await makeRoom(`${TAG}-announce-invite`, "announcements");
    const res = await request(app)
      .post(`/api/admin/chat/rooms/${roomId}/invite`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerAId] });
    expect(res.status).toBe(400);
    expect(await membershipStatus(roomId, ctx.officerAId)).toBeNull();
  });

  it("rejects empty/missing userIds (400) and unknown room (404)", async () => {
    const roomId = await makeRoom(`${TAG}-elite-badinvite`, "elite");
    expect(
      (await request(app)
        .post(`/api/admin/chat/rooms/${roomId}/invite`)
        .set(authed(ctx.adminToken))
        .send({ userIds: [] })).status,
    ).toBe(400);
    expect(
      (await request(app)
        .post(`/api/admin/chat/rooms/${roomId}/invite`)
        .set(authed(ctx.adminToken))
        .send({})).status,
    ).toBe(400);
    expect(
      (await request(app)
        .post(`/api/admin/chat/rooms/${randomUUID()}/invite`)
        .set(authed(ctx.adminToken))
        .send({ userIds: [ctx.officerAId] })).status,
    ).toBe(404);
  });

  it("rejects non-admin callers (403) and unauthenticated callers (401)", async () => {
    const roomId = await makeRoom(`${TAG}-elite-invite-auth`, "elite");
    expect(
      (await request(app)
        .post(`/api/admin/chat/rooms/${roomId}/invite`)
        .set(authed(ctx.officerAToken))
        .send({ userIds: [ctx.officerBId] })).status,
    ).toBe(403);
    expect(
      (await request(app)
        .post(`/api/admin/chat/rooms/${roomId}/invite`)
        .send({ userIds: [ctx.officerBId] })).status,
    ).toBe(401);
    // The unauthorized attempts must not have added anyone.
    expect(await membershipStatus(roomId, ctx.officerBId)).toBeNull();
  });
});

describe("DELETE /admin/chat/rooms/:id/members/:userId", () => {
  it("kicks an active member so they lose access to the room", async () => {
    const roomId = await makeRoom(`${TAG}-elite-kick`, "elite");
    await request(app)
      .post(`/api/admin/chat/rooms/${roomId}/invite`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerAId] })
      .expect(200);
    expect(await listRoomIds(ctx.officerAToken)).toContain(roomId);

    const kick = await request(app)
      .delete(`/api/admin/chat/rooms/${roomId}/members/${ctx.officerAId}`)
      .set(authed(ctx.adminToken));
    expect(kick.status).toBe(200);
    expect(kick.body.ok).toBe(true);

    expect(await membershipStatus(roomId, ctx.officerAId)).toBeNull();
    expect(await listRoomIds(ctx.officerAToken)).not.toContain(roomId);
  });

  it("rejects non-admin callers (403) and unauthenticated callers (401)", async () => {
    const roomId = await makeRoom(`${TAG}-elite-kick-auth`, "elite");
    await request(app)
      .post(`/api/admin/chat/rooms/${roomId}/invite`)
      .set(authed(ctx.adminToken))
      .send({ userIds: [ctx.officerBId] })
      .expect(200);

    expect(
      (await request(app)
        .delete(`/api/admin/chat/rooms/${roomId}/members/${ctx.officerBId}`)
        .set(authed(ctx.officerAToken))).status,
    ).toBe(403);
    expect(
      (await request(app).delete(`/api/admin/chat/rooms/${roomId}/members/${ctx.officerBId}`)).status,
    ).toBe(401);
    // A forbidden/unauthorized kick must NOT have removed the member.
    expect(await membershipStatus(roomId, ctx.officerBId)).toBe("active");
  });
});
