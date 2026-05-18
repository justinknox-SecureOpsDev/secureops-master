import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import request from "supertest";
import WebSocket from "ws";
import {
  db,
  usersTable,
  chatRoomsTable,
  chatRoomMembershipsTable,
  licensesTable,
  sitesTable,
  shiftsTable,
  clientsTable,
} from "@workspace/db";
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

// ============================================================ NON-DIRECT ROOM FAN-OUT
//
// The DM test above covers the strictest case (only the two participants).
// This block exercises every OTHER room type that resolveRoomMembers
// understands — ops / license_level / site / city / elite — plus the
// fail-closed path for unknown / legacy types. The contract under test is
// that POST /chat/rooms/:id/messages fans out via WS to exactly the set
// returned by resolveRoomMembers(room). Regressions that drop the
// allow-list, miscompute eligibility, or accidentally fall through to
// "broadcast to everyone" must be caught here.

const TAG2 = `wsbroadcast-rooms-${randomUUID().slice(0, 8)}`;

type RoomUser = User & { ws?: WebSocket };

const rooms = {} as {
  admin: RoomUser;        // role=admin: always in every non-direct set
  l3Officer: RoomUser;    // employee with unexpired L3 license
  l2Officer: RoomUser;    // employee with unexpired L2 license
  noLicOfficer: RoomUser; // employee with no license rows
  explicit: RoomUser;     // employee added to city + elite via memberships
  clientId: string;
  siteId: string;
  shiftId: string;
  l3LicenseId: string;
  opsRoomId: string;
  licenseRoomId: string;
  siteRoomId: string;
  cityRoomId: string;
  eliteRoomId: string;
  legacyRoomId: string;
  cityMembershipId: string;
  eliteMembershipId: string;
  server: http.Server;
  serverUrl: string;
};

async function mkUser(suffix: string, role: "admin" | "employee"): Promise<RoomUser> {
  const email = `${TAG2}-${suffix}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: suffix,
      lastName: TAG2,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  const token = signToken({ userId: row.id, email, role });
  return { id: row.id, email, token, role };
}

beforeAll(async () => {
  rooms.admin = await mkUser("admin", "admin");
  rooms.l3Officer = await mkUser("l3", "employee");
  rooms.l2Officer = await mkUser("l2", "employee");
  rooms.noLicOfficer = await mkUser("nolic", "employee");
  rooms.explicit = await mkUser("explicit", "employee");

  const futureDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const [l3Lic] = await db
    .insert(licensesTable)
    .values({
      employeeId: rooms.l3Officer.id,
      type: "tx_l3",
      level: 3,
      licenseNumber: `${TAG2}-L3`,
      expiryDate: futureDate,
    })
    .returning({ id: licensesTable.id });
  rooms.l3LicenseId = l3Lic.id;
  await db.insert(licensesTable).values({
    employeeId: rooms.l2Officer.id,
    type: "tx_l2",
    level: 2,
    licenseNumber: `${TAG2}-L2`,
    expiryDate: futureDate,
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG2}-client` })
    .returning({ id: clientsTable.id });
  rooms.clientId = client.id;
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: client.id, name: `${TAG2}-site` })
    .returning({ id: sitesTable.id });
  rooms.siteId = site.id;
  // Site channel membership floor is MIN(required_license_level) across the
  // site's shifts. Posting one L3 shift means only L3+ officers (and admins)
  // are auto-eligible — gives us a clean L2-vs-L3 split for the assertion.
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG2}-shift`,
      siteId: site.id,
      startTime: new Date(Date.now() + 86_400_000),
      endTime: new Date(Date.now() + 2 * 86_400_000),
      requiredLicenseLevel: 3,
    })
    .returning({ id: shiftsTable.id });
  rooms.shiftId = shift.id;

  const mkRoom = async (
    vals: Parameters<typeof db.insert<typeof chatRoomsTable>>[0] extends never ? never : Record<string, unknown>,
  ): Promise<string> => {
    const [r] = await db
      .insert(chatRoomsTable)
      .values(vals as never)
      .returning({ id: chatRoomsTable.id });
    return r.id;
  };
  rooms.opsRoomId = await mkRoom({ name: `${TAG2}-ops`, type: "ops" });
  rooms.licenseRoomId = await mkRoom({ name: `${TAG2}-lic3`, type: "license_level", licenseLevel: 3 });
  rooms.siteRoomId = await mkRoom({ name: `${TAG2}-site-rm`, type: "site", siteId: site.id });
  rooms.cityRoomId = await mkRoom({ name: `${TAG2}-city`, type: "city", city: "Austin" });
  rooms.eliteRoomId = await mkRoom({ name: `${TAG2}-elite`, type: "elite" });
  // Legacy / unknown room type. resolveRoomMembers must fail closed to
  // admins-only — old per-shift rows survived the migration to canonical
  // channels and must NOT silently fan out to every employee.
  rooms.legacyRoomId = await mkRoom({ name: `${TAG2}-legacy`, type: "shift", shiftId: shift.id });

  const [cityMem] = await db
    .insert(chatRoomMembershipsTable)
    .values({ roomId: rooms.cityRoomId, userId: rooms.explicit.id, status: "active" })
    .returning({ id: chatRoomMembershipsTable.id });
  rooms.cityMembershipId = cityMem.id;
  const [eliteMem] = await db
    .insert(chatRoomMembershipsTable)
    .values({ roomId: rooms.eliteRoomId, userId: rooms.explicit.id, status: "active" })
    .returning({ id: chatRoomMembershipsTable.id });
  rooms.eliteMembershipId = eliteMem.id;

  rooms.server = http.createServer(app);
  attachWebSocketServer(rooms.server);
  rooms.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname === "/api/ws") {
      handleChatUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => rooms.server.listen(0, resolve));
  const { port } = rooms.server.address() as AddressInfo;
  rooms.serverUrl = `ws://127.0.0.1:${port}/api/ws`;
});

afterAll(async () => {
  for (const u of [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit]) {
    if (u?.ws) { try { u.ws.terminate(); } catch { /* ignore */ } }
  }
  await new Promise<void>((resolve) => rooms.server.close(() => resolve()));
  const roomIds = [
    rooms.opsRoomId, rooms.licenseRoomId, rooms.siteRoomId,
    rooms.cityRoomId, rooms.eliteRoomId, rooms.legacyRoomId,
  ].filter(Boolean);
  for (const id of roomIds) {
    // chat_room_memberships + chat_messages cascade off chat_rooms.id, so
    // dropping the rooms is enough — but be explicit anyway for clarity.
    await db.execute(sql`DELETE FROM chat_messages WHERE room_id = ${id}`);
    await db.execute(sql`DELETE FROM chat_room_memberships WHERE room_id = ${id}`);
    await db.execute(sql`DELETE FROM chat_rooms WHERE id = ${id}`);
  }
  if (rooms.shiftId) await db.execute(sql`DELETE FROM shifts WHERE id = ${rooms.shiftId}`);
  if (rooms.siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${rooms.siteId}`);
  if (rooms.clientId) await db.execute(sql`DELETE FROM clients WHERE id = ${rooms.clientId}`);
  await db.execute(sql`DELETE FROM licenses WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG2})`);
  await db.execute(sql`DELETE FROM revoked_tokens WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG2})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG2}`);
});

function chatFramesFor(msgs: unknown[], roomId: string): Array<{ message: { content: string; roomId: string } }> {
  return msgs.filter((m): m is { type: string; message: { content: string; roomId: string } } =>
    typeof m === "object"
      && m !== null
      && (m as { type?: string }).type === "chat_message"
      && (m as { message?: { roomId?: string } }).message?.roomId === roomId,
  );
}

/**
 * Open a WS connection against the room-test server (separate http.Server
 * from the first describe block) and wait for the `connected` hello.
 */
function connectRoomUser(token: string, timeoutMs = 4000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${rooms.serverUrl}?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new Error("ws connect timeout"));
    }, timeoutMs);
    ws.once("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "connected") { clearTimeout(timer); resolve(ws); return; }
      } catch { /* ignore */ }
      clearTimeout(timer); reject(new Error(`unexpected first frame: ${data.toString()}`));
    });
    ws.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Drive a real POST /chat/rooms/:id/messages while collecting any frames
 * that arrive on each subject's already-open socket. Returns the parsed
 * `chat_message` frames per user that target the posted room.
 *
 * Arming the collectors BEFORE issuing the POST is essential — the route
 * handler fans out synchronously after the DB insert returns, and a
 * collector attached too late would miss the broadcast and yield a false
 * negative ("no leak"). The 250ms window gives the loopback fan-out
 * plenty of head-room without slowing the suite meaningfully.
 */
async function postAndCollect(
  poster: RoomUser,
  roomId: string,
  content: string,
  subjects: RoomUser[],
): Promise<Map<string, Array<{ message: { content: string; roomId: string } }>>> {
  const windowMs = 250;
  const pending = subjects.map((u) => ({
    u,
    promise: collectFor(u.ws!, windowMs),
  }));
  const res = await request(app)
    .post(`/api/chat/rooms/${roomId}/messages`)
    .set("Authorization", `Bearer ${poster.token}`)
    .send({ content });
  expect(res.status).toBe(201);
  const out = new Map<string, Array<{ message: { content: string; roomId: string } }>>();
  for (const { u, promise } of pending) {
    const msgs = await promise;
    out.set(u.id, chatFramesFor(msgs, roomId));
  }
  return out;
}

describe("WebSocket broadcast scoping by room type", () => {
  beforeAll(async () => {
    // One socket per user, reused across the tests in this block. Each
    // collectFor adds + removes a one-shot listener, so there is no state
    // pollution between cases.
    for (const u of [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit]) {
      u.ws = await connectRoomUser(u.token);
    }
  });

  it("ops rooms broadcast to admins only (officers never see ops traffic)", async () => {
    const subjects = [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit];
    const got = await postAndCollect(rooms.admin, rooms.opsRoomId, "ops-channel-traffic", subjects);
    expect(got.get(rooms.admin.id)).toHaveLength(1);
    for (const u of [rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit]) {
      expect(got.get(u.id)).toHaveLength(0);
    }
  });

  it("license_level rooms reach officers at-or-above the threshold and exclude under-qualified officers", async () => {
    const subjects = [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit];
    const got = await postAndCollect(rooms.admin, rooms.licenseRoomId, "lic3-only", subjects);
    expect(got.get(rooms.admin.id)).toHaveLength(1);     // admin always in
    expect(got.get(rooms.l3Officer.id)).toHaveLength(1); // L3 ≥ 3 → in
    expect(got.get(rooms.l2Officer.id)).toHaveLength(0); // L2 < 3 → out
    expect(got.get(rooms.noLicOfficer.id)).toHaveLength(0);
    expect(got.get(rooms.explicit.id)).toHaveLength(0);  // no license → out
  });

  it("expiring a license removes the officer from the next license_level broadcast (eligibility-loss live check)", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.update(licensesTable).set({ expiryDate: yesterday }).where(eq(licensesTable.id, rooms.l3LicenseId));
    try {
      // Re-post on the SAME socket the officer used in the previous test.
      // If resolveRoomMembers cached the answer or the route reused a
      // stale member set, the L3 officer would still receive — and this
      // assertion would fail. We want every broadcast to re-resolve.
      const got = await postAndCollect(
        rooms.admin,
        rooms.licenseRoomId,
        "post-expiry-lic3",
        [rooms.admin, rooms.l3Officer],
      );
      expect(got.get(rooms.admin.id)).toHaveLength(1);
      expect(got.get(rooms.l3Officer.id)).toHaveLength(0);
    } finally {
      const futureDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
      await db.update(licensesTable).set({ expiryDate: futureDate }).where(eq(licensesTable.id, rooms.l3LicenseId));
    }
  });

  it("site rooms reach officers who clear MIN(required_license_level) across the site's shifts and exclude the rest", async () => {
    const subjects = [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit];
    const got = await postAndCollect(rooms.admin, rooms.siteRoomId, "site-traffic", subjects);
    expect(got.get(rooms.admin.id)).toHaveLength(1);
    expect(got.get(rooms.l3Officer.id)).toHaveLength(1); // qualifies for the L3 shift
    expect(got.get(rooms.l2Officer.id)).toHaveLength(0);
    expect(got.get(rooms.noLicOfficer.id)).toHaveLength(0);
    expect(got.get(rooms.explicit.id)).toHaveLength(0);
  });

  it("city rooms reach only admins + users with an active/invited membership row", async () => {
    const subjects = [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit];
    const got = await postAndCollect(rooms.admin, rooms.cityRoomId, "city-traffic", subjects);
    expect(got.get(rooms.admin.id)).toHaveLength(1);
    expect(got.get(rooms.explicit.id)).toHaveLength(1); // active membership → in
    for (const u of [rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer]) {
      expect(got.get(u.id)).toHaveLength(0); // license/role does NOT auto-add to city
    }
  });

  it("elite rooms reach only admins + explicit members; revoking the membership cuts the next broadcast", async () => {
    const subjects = [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit];
    const before = await postAndCollect(rooms.admin, rooms.eliteRoomId, "elite-first", subjects);
    expect(before.get(rooms.admin.id)).toHaveLength(1);
    expect(before.get(rooms.explicit.id)).toHaveLength(1);
    for (const u of [rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer]) {
      expect(before.get(u.id)).toHaveLength(0);
    }

    // Kick the explicit member — this mirrors DELETE
    // /admin/chat/rooms/:id/members/:userId. The next broadcast must NOT
    // reach them, even though their socket is still open and authenticated.
    await db
      .delete(chatRoomMembershipsTable)
      .where(eq(chatRoomMembershipsTable.id, rooms.eliteMembershipId));

    const after = await postAndCollect(
      rooms.admin,
      rooms.eliteRoomId,
      "elite-after-revoke",
      [rooms.admin, rooms.explicit],
    );
    expect(after.get(rooms.admin.id)).toHaveLength(1);
    expect(after.get(rooms.explicit.id)).toHaveLength(0);
  });

  it("unknown / legacy room types (e.g. orphaned 'shift' rows) fail closed to admins only", async () => {
    // The contract: resolveRoomMembers' final branch returns an
    // admins-only Set for any room.type it does not explicitly handle.
    // If a future refactor changed that to "broadcast to everyone" or
    // dropped the allow-list, every leftover legacy room in the DB would
    // start leaking to every employee — exactly what this assertion blocks.
    const subjects = [rooms.admin, rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit];
    const got = await postAndCollect(rooms.admin, rooms.legacyRoomId, "legacy-shift-room", subjects);
    expect(got.get(rooms.admin.id)).toHaveLength(1);
    for (const u of [rooms.l3Officer, rooms.l2Officer, rooms.noLicOfficer, rooms.explicit]) {
      expect(got.get(u.id)).toHaveLength(0);
    }
  });
});
