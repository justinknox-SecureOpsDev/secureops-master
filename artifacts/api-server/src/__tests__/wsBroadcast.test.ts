import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import request from "supertest";
import WebSocket from "ws";
import { db, usersTable, chatRoomsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import {
  attachWebSocketServer,
  handleChatUpgrade,
  disconnectUser,
} from "../lib/wsManager";

const TAG = `wsbroadcast-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type User = { id: string; email: string; token: string; role: "admin" | "employee" };

const ctx = {} as {
  alice: User;
  bob: User;
  carol: User;
  dmRoomId: string;
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
  // Carol is an ADMIN deliberately. Direct rooms must NEVER fan out
  // to anyone but the two participants — not even admins. If a future
  // change accidentally grants admins broad chat oversight, this test
  // will catch the leak.
  ctx.carol = await makeUser("carol", "admin");

  const directKey = [ctx.alice.id, ctx.bob.id].sort().join(":");
  const [room] = await db
    .insert(chatRoomsTable)
    .values({
      name: `${TAG}-dm`,
      type: "direct",
      directKey,
    })
    .returning({ id: chatRoomsTable.id });
  ctx.dmRoomId = room.id;

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
  await db.execute(sql`DELETE FROM chat_messages WHERE room_id = ${ctx.dmRoomId}`);
  await db.execute(sql`DELETE FROM chat_rooms WHERE id = ${ctx.dmRoomId}`);
  await db.execute(sql`DELETE FROM revoked_tokens WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

/**
 * Open a WS connection and resolve once the server has sent its
 * `{type:"connected"}` hello — which is the signal that the socket is
 * registered in the connections map and eligible for broadcasts.
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
        if (msg.type === "connected") {
          clearTimeout(timer);
          resolve(ws);
          return;
        }
      } catch { /* ignore */ }
      clearTimeout(timer);
      reject(new Error(`unexpected first frame: ${data.toString()}`));
    });
    ws.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Wait `windowMs` and return every parsed message that arrived during the
 * window. Used to assert "this socket did NOT receive a message" — the only
 * reliable way is to give the broadcast time to fan out and then look.
 */
function collectFor(ws: WebSocket, windowMs: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const received: unknown[] = [];
    const onMsg = (data: WebSocket.RawData) => {
      try { received.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    };
    ws.on("message", onMsg);
    setTimeout(() => {
      ws.off("message", onMsg);
      resolve(received);
    }, windowMs);
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 4000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("WebSocket broadcast scoping + live revocation", () => {
  it("POST /chat/rooms/:id/messages on a DM fans out only to the two participants — not even an admin outsider", async () => {
    const [aliceWs, bobWs, carolWs] = await Promise.all([
      connectAuthed(ctx.alice.token),
      connectAuthed(ctx.bob.token),
      connectAuthed(ctx.carol.token),
    ]);

    try {
      // Pre-arm collectors BEFORE the HTTP POST so we cannot miss the
      // broadcast frame triggered by the route handler.
      const alicePromise = collectFor(aliceWs, 500);
      const bobPromise = collectFor(bobWs, 500);
      const carolPromise = collectFor(carolWs, 500);

      // Drive the REAL route — this is the regression surface. The
      // handler computes `resolveRoomMembers(room)` and passes that as
      // `allowedUserIds` to `broadcastToRoom`. If a future change drops
      // the allow-list or miscomputes membership, carol (an admin who
      // is NOT in this DM) would see the frame and this test fails.
      const res = await request(app)
        .post(`/api/chat/rooms/${ctx.dmRoomId}/messages`)
        .set("Authorization", `Bearer ${ctx.alice.token}`)
        .send({ content: "private hello" });
      expect(res.status).toBe(201);

      const [aliceMsgs, bobMsgs, carolMsgs] = await Promise.all([alicePromise, bobPromise, carolPromise]);

      const chatFrames = (msgs: unknown[]) =>
        msgs.filter((m): m is { type: string; message: { content: string } } =>
          typeof m === "object" && m !== null && (m as { type?: string }).type === "chat_message",
        );

      const aliceChat = chatFrames(aliceMsgs);
      const bobChat = chatFrames(bobMsgs);
      const carolChat = chatFrames(carolMsgs);

      expect(aliceChat).toHaveLength(1);
      expect(bobChat).toHaveLength(1);
      expect(carolChat).toHaveLength(0);
      expect(aliceChat[0].message.content).toBe("private hello");
      expect(bobChat[0].message.content).toBe("private hello");
    } finally {
      for (const ws of [aliceWs, bobWs, carolWs]) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  });

  it("bumping tokensValidAfter + disconnectUser cuts a live socket immediately", async () => {
    const ws = await connectAuthed(ctx.alice.token);

    try {
      const closePromise = waitForClose(ws);

      // Bump the watermark so any reconnect with this token is rejected by
      // the upgrade handler, then sever the currently-open socket — this is
      // the contract POST /auth/logout-all and admin revoke-sessions rely on.
      await db
        .update(usersTable)
        .set({ tokensValidAfter: new Date(Date.now() + 60_000) })
        .where(eq(usersTable.id, ctx.alice.id));
      disconnectUser(ctx.alice.id);

      const closed = await closePromise;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toMatch(/revoked/i);
    } finally {
      try { ws.terminate(); } catch { /* ignore */ }
      // Restore so this user can be reused by any later test.
      await db
        .update(usersTable)
        .set({ tokensValidAfter: new Date(0) })
        .where(eq(usersTable.id, ctx.alice.id));
    }
  });
});
