import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { URL } from "node:url";
import request from "supertest";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { db, usersTable, chatRoomsTable, chatMessagesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { attachWebSocketServer, handleChatUpgrade } from "../lib/wsManager";

// Exercises the authorization branch on DELETE /chat/messages/:id:
//   - an officer can delete their OWN message (200) but is forbidden (403)
//     from deleting another user's message;
//   - an admin can delete ANY user's message (200);
//   - deleting a non-existent message id returns 404.
//
// Rows are tagged so cleanup scopes precisely and never trashes seed data,
// mirroring chatRoomAccess.test.ts.
const TAG = `chat-msgdel-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerAId: string;
  officerBId: string;
  adminToken: string;
  officerAToken: string;
  officerBToken: string;
  roomId: string;
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

async function postMessage(roomId: string, userId: string, content: string): Promise<string> {
  const [row] = await db
    .insert(chatMessagesTable)
    .values({ roomId, userId, content })
    .returning({ id: chatMessagesTable.id });
  return row.id;
}

async function messageExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatMessagesTable.id })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.id, id))
    .limit(1);
  return Boolean(row);
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerAId = await makeUser("employee", "a");
  ctx.officerBId = await makeUser("employee", "b");

  ctx.adminToken = tokenFor(ctx.adminId, "admin", "admin");
  ctx.officerAToken = tokenFor(ctx.officerAId, "employee", "a");
  ctx.officerBToken = tokenFor(ctx.officerBId, "employee", "b");

  // Announcements room is visible/authorized for every authenticated user,
  // so room-level access never confounds the delete-ownership assertions.
  const [room] = await db
    .insert(chatRoomsTable)
    .values({ name: `${TAG}-announcements`, type: "announcements" })
    .returning({ id: chatRoomsTable.id });
  ctx.roomId = room.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Pool closed by globalTeardown.
});

describe("DELETE /chat/messages/:id — who can delete what", () => {
  it("officer can delete their OWN message (200) and it is removed", async () => {
    const msgId = await postMessage(ctx.roomId, ctx.officerAId, "mine to delete");

    const res = await request(app)
      .delete(`/api/chat/messages/${msgId}`)
      .set(authed(ctx.officerAToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: msgId });
    expect(await messageExists(msgId)).toBe(false);
  });

  it("officer is forbidden (403) from deleting another user's message; it survives", async () => {
    const msgId = await postMessage(ctx.roomId, ctx.officerAId, "officer A's message");

    const res = await request(app)
      .delete(`/api/chat/messages/${msgId}`)
      .set(authed(ctx.officerBToken));

    expect(res.status).toBe(403);
    // The message must NOT have been deleted by the unauthorized attempt.
    expect(await messageExists(msgId)).toBe(true);
  });

  it("admin can delete ANY user's message (200) and it is removed", async () => {
    const msgId = await postMessage(ctx.roomId, ctx.officerAId, "officer A's message");

    const res = await request(app)
      .delete(`/api/chat/messages/${msgId}`)
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: msgId });
    expect(await messageExists(msgId)).toBe(false);
  });

  it("deleting a non-existent message id returns 404", async () => {
    const res = await request(app)
      .delete(`/api/chat/messages/${randomUUID()}`)
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(404);
  });
});

// ============================================================ DELETION BROADCAST SCOPING
//
// When a message is deleted, the route fans out a `chat_message_deleted`
// event so open chat views drop the bubble in real time. That fan-out is
// scoped through the SAME resolveRoomMembers + broadcastToRoom path the
// message-creation broadcast uses:
//   - private rooms (direct / elite / city / ...) → only authorized members
//   - open rooms (announcements) → every connected client
//
// The risk being guarded: a regression that drops the allow-list on the
// deletion broadcast would leak the deleted messageId + roomId to users who
// were never in the room. These tests drive the REAL DELETE route over live
// WebSocket sockets and assert exactly who receives the frame.

const WTAG = `chat-msgdel-ws-${randomUUID().slice(0, 8)}`;

const wsCtx = {} as {
  aliceId: string;
  bobId: string;
  aliceToken: string;
  bobToken: string;
  // Carol is an ADMIN deliberately. A direct room must NEVER fan its
  // deletion event out to anyone but the two participants — not even an
  // admin who is outside the conversation. If a future change grants admins
  // blanket chat oversight, this catches the leak.
  carolToken: string;
  dmRoomId: string;
  announceRoomId: string;
  server: http.Server;
  serverUrl: string;
};

async function makeWsUser(suffix: string, role: "admin" | "employee"): Promise<{ id: string; token: string }> {
  const email = `${WTAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: suffix,
      lastName: WTAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, token: signToken({ userId: row.id, email, role }) };
}

/**
 * Open a WS connection and resolve once the server sends its
 * `{type:"connected"}` hello — the signal that the socket is registered in
 * the connections map and eligible for broadcasts.
 */
function connectAuthed(serverUrl: string, token: string, timeoutMs = 4000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${serverUrl}?token=${encodeURIComponent(token)}`);
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

/**
 * Wait `windowMs` and return every parsed message that arrived during the
 * window. The only reliable way to assert "this socket did NOT receive a
 * frame" is to give the broadcast time to fan out and then look.
 */
function collectFor(ws: WebSocket, windowMs: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const received: unknown[] = [];
    const onMsg = (data: WebSocket.RawData) => {
      try { received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    };
    ws.on("message", onMsg);
    setTimeout(() => { ws.off("message", onMsg); resolve(received); }, windowMs);
  });
}

function deletionFramesFor(msgs: unknown[], messageId: string): Array<{ messageId: string; roomId: string }> {
  return msgs.filter((m): m is { type: string; messageId: string; roomId: string } =>
    typeof m === "object"
      && m !== null
      && (m as { type?: string }).type === "chat_message_deleted"
      && (m as { messageId?: string }).messageId === messageId,
  );
}

describe("DELETE /chat/messages/:id — deletion event broadcast scoping", () => {
  beforeAll(async () => {
    const [alice, bob, carol] = await Promise.all([
      makeWsUser("alice", "employee"),
      makeWsUser("bob", "employee"),
      makeWsUser("carol", "admin"),
    ]);
    wsCtx.aliceId = alice.id;
    wsCtx.bobId = bob.id;
    wsCtx.aliceToken = alice.token;
    wsCtx.bobToken = bob.token;
    wsCtx.carolToken = carol.token;

    const directKey = [alice.id, bob.id].sort().join(":");
    const [dm] = await db
      .insert(chatRoomsTable)
      .values({ name: `${WTAG}-dm`, type: "direct", directKey })
      .returning({ id: chatRoomsTable.id });
    wsCtx.dmRoomId = dm.id;

    const [announce] = await db
      .insert(chatRoomsTable)
      .values({ name: `${WTAG}-announcements`, type: "announcements" })
      .returning({ id: chatRoomsTable.id });
    wsCtx.announceRoomId = announce.id;

    wsCtx.server = http.createServer(app);
    attachWebSocketServer(wsCtx.server);
    wsCtx.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname === "/api/ws") { handleChatUpgrade(req, socket, head); }
      else { socket.destroy(); }
    });
    await new Promise<void>((resolve) => wsCtx.server.listen(0, resolve));
    const { port } = wsCtx.server.address() as AddressInfo;
    wsCtx.serverUrl = `ws://127.0.0.1:${port}/api/ws`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wsCtx.server.close(() => resolve()));
    await db.execute(sql`DELETE FROM chat_messages WHERE room_id IN (${wsCtx.dmRoomId}, ${wsCtx.announceRoomId})`);
    await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${WTAG + "%"}`);
    await db.execute(sql`DELETE FROM users WHERE last_name = ${WTAG}`);
  });

  it("deleting a private (direct) room message broadcasts chat_message_deleted ONLY to the two participants, not an admin outsider", async () => {
    const [aliceWs, bobWs, carolWs] = await Promise.all([
      connectAuthed(wsCtx.serverUrl, wsCtx.aliceToken),
      connectAuthed(wsCtx.serverUrl, wsCtx.bobToken),
      connectAuthed(wsCtx.serverUrl, wsCtx.carolToken),
    ]);

    try {
      // Alice owns the message she's deleting (officers can delete their own).
      const msgId = await postMessage(wsCtx.dmRoomId, wsCtx.aliceId, "dm to be deleted");

      // Arm collectors BEFORE the HTTP DELETE so we cannot miss the frame
      // the route fans out synchronously after the DB delete returns.
      const alicePromise = collectFor(aliceWs, 500);
      const bobPromise = collectFor(bobWs, 500);
      const carolPromise = collectFor(carolWs, 500);

      const res = await request(app)
        .delete(`/api/chat/messages/${msgId}`)
        .set(authed(wsCtx.aliceToken));
      expect(res.status).toBe(200);

      const [aliceMsgs, bobMsgs, carolMsgs] = await Promise.all([alicePromise, bobPromise, carolPromise]);

      // Both DM participants get the deletion event...
      expect(deletionFramesFor(aliceMsgs, msgId)).toHaveLength(1);
      expect(deletionFramesFor(bobMsgs, msgId)).toHaveLength(1);
      // ...but carol — an admin who is NOT in this DM — must NOT.
      expect(deletionFramesFor(carolMsgs, msgId)).toHaveLength(0);
    } finally {
      for (const ws of [aliceWs, bobWs, carolWs]) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  });

  it("deleting an open (announcements) room message broadcasts chat_message_deleted to ALL connected clients", async () => {
    const [aliceWs, bobWs, carolWs] = await Promise.all([
      connectAuthed(wsCtx.serverUrl, wsCtx.aliceToken),
      connectAuthed(wsCtx.serverUrl, wsCtx.bobToken),
      connectAuthed(wsCtx.serverUrl, wsCtx.carolToken),
    ]);

    try {
      // Carol (admin) can delete any message; the message itself belongs to
      // bob to prove deletion authorization and broadcast scope are separate.
      const msgId = await postMessage(wsCtx.announceRoomId, wsCtx.bobId, "announcement to be deleted");

      const alicePromise = collectFor(aliceWs, 500);
      const bobPromise = collectFor(bobWs, 500);
      const carolPromise = collectFor(carolWs, 500);

      const res = await request(app)
        .delete(`/api/chat/messages/${msgId}`)
        .set(authed(wsCtx.carolToken));
      expect(res.status).toBe(200);

      const [aliceMsgs, bobMsgs, carolMsgs] = await Promise.all([alicePromise, bobPromise, carolPromise]);

      // Open room → resolveRoomMembers returns null → everyone connected hears it.
      expect(deletionFramesFor(aliceMsgs, msgId)).toHaveLength(1);
      expect(deletionFramesFor(bobMsgs, msgId)).toHaveLength(1);
      expect(deletionFramesFor(carolMsgs, msgId)).toHaveLength(1);
    } finally {
      for (const ws of [aliceWs, bobWs, carolWs]) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  });
});
