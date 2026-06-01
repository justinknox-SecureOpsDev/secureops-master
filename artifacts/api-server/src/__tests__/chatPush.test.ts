import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import request from "supertest";
import WebSocket from "ws";
import {
  db,
  usersTable,
  chatRoomsTable,
  chatRoomMembershipsTable,
} from "@workspace/db";

// The push fan-out in POST /chat/rooms/:id/messages is the surface under
// test. We mock lib/push so the route's recipient computation is observable
// without touching Expo or the notifications table — those belong to the
// push.test.ts unit. broadcastToRoom + getConnectedUserIds stay REAL so the
// "connected officers are skipped" branch is exercised against an actual
// live socket registry rather than a stub.
vi.mock("../lib/push", () => ({
  sendPushToUsers: vi.fn(() => Promise.resolve()),
}));

import app from "../app";
import { signToken } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";
import {
  attachWebSocketServer,
  handleChatUpgrade,
} from "../lib/wsManager";

const mockedSendPush = vi.mocked(sendPushToUsers);

const TAG = `chatpush-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type User = { id: string; email: string; token: string; role: "admin" | "employee" };

const ctx = {} as {
  alice: User; // sender (employee)
  bob: User; // member who connects over WS → must be skipped for push
  carol: User; // member who stays offline → must receive a push
  dave: User; // admin, used to post in the announcements channel
  eliteRoomId: string;
  dmRoomId: string;
  announcementsRoomId: string;
  server: http.Server;
  serverUrl: string;
};

async function makeUser(suffix: string, role: "admin" | "employee"): Promise<User> {
  const email = `${TAG}-${suffix}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  const token = signToken({ userId: row.id, email, role });
  return { id: row.id, email, token, role };
}

beforeAll(async () => {
  ctx.alice = await makeUser("alice", "employee");
  ctx.bob = await makeUser("bob", "employee");
  ctx.carol = await makeUser("carol", "employee");
  ctx.dave = await makeUser("dave", "admin");

  // Elite room: membership is the explicit memberships set (plus any
  // admins). Adding the three employees gives us a deterministic member
  // set whose non-admin portion we fully control.
  const [elite] = await db
    .insert(chatRoomsTable)
    .values({ name: `${TAG}-elite`, type: "elite" })
    .returning({ id: chatRoomsTable.id });
  ctx.eliteRoomId = elite.id;
  await db.insert(chatRoomMembershipsTable).values([
    { roomId: elite.id, userId: ctx.alice.id, status: "active" },
    { roomId: elite.id, userId: ctx.bob.id, status: "active" },
    { roomId: elite.id, userId: ctx.carol.id, status: "active" },
  ]);

  const directKey = [ctx.alice.id, ctx.carol.id].sort().join(":");
  const [dm] = await db
    .insert(chatRoomsTable)
    .values({ name: `${TAG}-dm`, type: "direct", directKey })
    .returning({ id: chatRoomsTable.id });
  ctx.dmRoomId = dm.id;

  const [announce] = await db
    .insert(chatRoomsTable)
    .values({ name: `${TAG}-announce`, type: "announcements" })
    .returning({ id: chatRoomsTable.id });
  ctx.announcementsRoomId = announce.id;

  ctx.server = http.createServer(app);
  attachWebSocketServer(ctx.server);
  ctx.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname === "/api/ws") {
      handleChatUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => ctx.server.listen(0, resolve));
  const { port } = ctx.server.address() as AddressInfo;
  ctx.serverUrl = `ws://127.0.0.1:${port}/api/ws`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  const roomIds = [ctx.eliteRoomId, ctx.dmRoomId, ctx.announcementsRoomId].filter(Boolean);
  for (const id of roomIds) {
    await db.execute(sql`DELETE FROM chat_messages WHERE room_id = ${id}`);
    await db.execute(sql`DELETE FROM chat_room_memberships WHERE room_id = ${id}`);
    await db.execute(sql`DELETE FROM chat_rooms WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

beforeEach(() => {
  mockedSendPush.mockClear();
});

/**
 * Open a WS connection and resolve once the server's `{type:"connected"}`
 * hello arrives — that frame is the signal the socket is registered in the
 * connections map (and therefore counted by getConnectedUserIds).
 */
function connectAuthed(token: string, timeoutMs = 4000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ctx.serverUrl}?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new Error("ws connect timeout"));
    }, timeoutMs);
    ws.once("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "connected") { clearTimeout(timer); resolve(ws); return; }
      } catch { /* ignore */ }
      clearTimeout(timer);
      reject(new Error(`unexpected first frame: ${data.toString()}`));
    });
    ws.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.once("close", () => { clearTimeout(timer); resolve(); });
    try { ws.close(); } catch { /* ignore */ }
  });
}

/** Last recipient list + notification arg passed to the mocked sendPushToUsers. */
function lastPushCall(): { recipients: string[]; notification: { title: string; body: string; data?: Record<string, unknown> } } {
  expect(mockedSendPush).toHaveBeenCalledTimes(1);
  const [recipients, notification] = mockedSendPush.mock.calls[0] as [
    string[],
    { title: string; body: string; data?: Record<string, unknown> },
  ];
  return { recipients, notification };
}

describe("POST /chat/rooms/:id/messages — push fan-out", () => {
  it("excludes the sender, skips WS-connected members, and pushes only to offline members", async () => {
    // Bob connects over WS (so he is "online"); Carol stays offline.
    const bobWs = await connectAuthed(ctx.bob.token);
    try {
      const res = await request(app)
        .post(`/api/chat/rooms/${ctx.eliteRoomId}/messages`)
        .set("Authorization", `Bearer ${ctx.alice.token}`)
        .send({ content: "elite channel message" });
      expect(res.status).toBe(201);

      const { recipients, notification } = lastPushCall();
      // Offline member is pushed.
      expect(recipients).toContain(ctx.carol.id);
      // Sender is never pushed (they already have the message in the response).
      expect(recipients).not.toContain(ctx.alice.id);
      // WS-connected member is skipped (they get the live broadcast instead).
      expect(recipients).not.toContain(ctx.bob.id);

      // Non-direct room payload: title is "#<room>", body is "<sender>: <preview>".
      expect(notification.title).toBe(`#${TAG}-elite`);
      expect(notification.body).toBe(`alice ${TAG}: elite channel message`);
      expect(notification.data).toEqual({
        roomId: ctx.eliteRoomId,
        type: "chat_message",
        roomName: `${TAG}-elite`,
      });
    } finally {
      await waitForClose(bobWs);
    }
  });

  it("includes a member who has no live socket (everyone offline → all non-senders pushed)", async () => {
    // No sockets open at all: both Bob and Carol are offline members.
    const res = await request(app)
      .post(`/api/chat/rooms/${ctx.eliteRoomId}/messages`)
      .set("Authorization", `Bearer ${ctx.alice.token}`)
      .send({ content: "second elite message" });
    expect(res.status).toBe(201);

    const { recipients } = lastPushCall();
    expect(recipients).toContain(ctx.bob.id);
    expect(recipients).toContain(ctx.carol.id);
    expect(recipients).not.toContain(ctx.alice.id);
  });

  it("uses the sender's name as the room label for direct-message pushes", async () => {
    const res = await request(app)
      .post(`/api/chat/rooms/${ctx.dmRoomId}/messages`)
      .set("Authorization", `Bearer ${ctx.alice.token}`)
      .send({ content: "hey carol" });
    expect(res.status).toBe(201);

    const { recipients, notification } = lastPushCall();
    expect(recipients).toEqual([ctx.carol.id]);
    // Direct rooms: title + roomName are the sender's full name, body is the
    // bare preview (no "name:" prefix).
    expect(notification.title).toBe(`alice ${TAG}`);
    expect(notification.body).toBe("hey carol");
    expect(notification.data).toEqual({
      roomId: ctx.dmRoomId,
      type: "chat_message",
      roomName: `alice ${TAG}`,
    });
  });

  it("never pushes for announcements broadcasts (members === null is too broad for push)", async () => {
    // Post as an admin so the message actually lands (announcements are
    // admin/dispatcher-only). The message succeeds and fans out over WS to
    // everyone, but the push branch is intentionally skipped because
    // resolveRoomMembers returns null for announcements.
    const res = await request(app)
      .post(`/api/chat/rooms/${ctx.announcementsRoomId}/messages`)
      .set("Authorization", `Bearer ${ctx.dave.token}`)
      .send({ content: "all-hands notice" });
    expect(res.status).toBe(201);
    expect(mockedSendPush).not.toHaveBeenCalled();
  });
});
