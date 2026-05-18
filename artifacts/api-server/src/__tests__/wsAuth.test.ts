import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import WebSocket from "ws";
import { db, usersTable, revokedTokensTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { attachWebSocketServer, handleChatUpgrade } from "../lib/wsManager";

const TAG = `wsauth-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  userId: string;
  email: string;
  serverUrl: string;
  server: http.Server;
};
const ctx = {} as Ctx;

async function makeUser(suffix: string): Promise<{ id: string; email: string }> {
  const email = `${TAG}-${suffix}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: "WS",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, email };
}

beforeAll(async () => {
  const u = await makeUser("user");
  ctx.userId = u.id;
  ctx.email = u.email;

  // Spin up a real http server bound to a free port so we can drive the
  // upgrade handshake from a real `ws` client. The express app alone (as
  // used by supertest) does NOT provide the `upgrade` event that the WS
  // server hooks into.
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
  // revoked_tokens has a FK on users via userId; clean it first.
  await db.execute(sql`DELETE FROM revoked_tokens WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

type Outcome =
  | { kind: "open"; message: string }
  | { kind: "closed"; code: number; reason: string }
  | { kind: "error"; error: Error };

// Connect to the WS endpoint and resolve with what happened: either the
// first message received (success), or the close code + reason (rejection).
async function connectAndCollect(token: string | null, timeoutMs = 4000): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const url = token == null ? ctx.serverUrl : `${ctx.serverUrl}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const finish = (o: Outcome) => {
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ kind: "error", error: new Error("ws timeout") }), timeoutMs);
    ws.once("message", (data) => finish({ kind: "open", message: data.toString() }));
    ws.once("close", (code, reason) => finish({ kind: "closed", code, reason: reason.toString() }));
    ws.once("error", () => { /* swallow — close event carries the reason */ });
  });
}

describe("/api/ws auth + revocation", () => {
  it("accepts a valid token and sends the {type:'connected'} hello", async () => {
    const token = signToken({ userId: ctx.userId, email: ctx.email, role: "employee" });
    const out = await connectAndCollect(token);
    expect(out.kind).toBe("open");
    if (out.kind === "open") {
      const msg = JSON.parse(out.message);
      expect(msg.type).toBe("connected");
      expect(msg.userId).toBe(ctx.userId);
    }
  });

  it("closes with 1008 'Token required' when the upgrade has no token", async () => {
    const out = await connectAndCollect(null);
    expect(out.kind).toBe("closed");
    if (out.kind === "closed") {
      expect(out.code).toBe(1008);
      expect(out.reason).toMatch(/token required/i);
    }
  });

  it("closes with 1008 'Invalid token' on a malformed JWT", async () => {
    const out = await connectAndCollect("not-a-real-jwt");
    expect(out.kind).toBe("closed");
    if (out.kind === "closed") {
      expect(out.code).toBe(1008);
      expect(out.reason).toMatch(/invalid token/i);
    }
  });

  it("rejects a token whose iat is below the user's tokensValidAfter watermark (logout-all)", async () => {
    // Sign first, THEN bump the watermark into the future so this token's
    // iat (now, seconds) is strictly less than tokensValidAfter (ms).
    const token = signToken({ userId: ctx.userId, email: ctx.email, role: "employee" });
    const future = new Date(Date.now() + 60_000);
    await db.update(usersTable).set({ tokensValidAfter: future }).where(eq(usersTable.id, ctx.userId));
    try {
      const out = await connectAndCollect(token);
      expect(out.kind).toBe("closed");
      if (out.kind === "closed") {
        expect(out.code).toBe(1008);
        expect(out.reason).toMatch(/revoked/i);
      }
    } finally {
      // Restore so the other tests in this file (and any later tests
      // reusing this user) are not affected.
      await db.update(usersTable).set({ tokensValidAfter: new Date(0) }).where(eq(usersTable.id, ctx.userId));
    }
  });

  it("rejects a token whose jti is in revoked_tokens (single-session logout)", async () => {
    const token = signToken({ userId: ctx.userId, email: ctx.email, role: "employee" });
    // signToken stamps a jti; pull it back out via the verify helper.
    const { verifyToken } = await import("../middlewares/auth");
    const decoded = verifyToken(token);
    expect(decoded.jti).toBeTruthy();

    await db.insert(revokedTokensTable).values({
      jti: decoded.jti!,
      userId: ctx.userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const out = await connectAndCollect(token);
    expect(out.kind).toBe("closed");
    if (out.kind === "closed") {
      expect(out.code).toBe(1008);
      expect(out.reason).toMatch(/revoked/i);
    }
  });
});
