import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import WebSocket from "ws";
import { inArray, like, eq } from "drizzle-orm";
import { db, usersTable, radioChannelsTable, radioTransmissionsTable, clientsTable, sitesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { attachRadioWebSocketServer, handleRadioUpgrade } from "../lib/radioGateway";

// Exercises the LiveKit token endpoints + the recording-free audit trail.
//   - subscribe token allowed for an authorised member, denied otherwise
//   - publish token refused unless the caller holds the speaker lock
//   - transmissions list is metadata-only (no audio* fields)
//   - the old playback route is gone
const TAG = `radio-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const URL = "wss://test.livekit.cloud";
const KEY = "APItestkey";
const SECRET = "test-livekit-secret-at-least-32-characters-long";

let adminId = "";
let officerId = "";
let adminToken = "";
let officerToken = "";
let globalChannelId = "";
let adminChannelId = "";
let clientId = "";
let siteId = "";
let editChannelId = "";

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
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env.LIVEKIT_URL = URL;
  process.env.LIVEKIT_API_KEY = KEY;
  process.env.LIVEKIT_API_SECRET = SECRET;

  adminId = await makeUser("admin", "admin");
  officerId = await makeUser("employee", "officer");
  adminToken = signToken({ userId: adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  officerToken = signToken({ userId: officerId, email: `${TAG}-officer@example.test`, role: "employee" });

  const [globalCh] = await db
    .insert(radioChannelsTable)
    .values({ name: `${TAG} Global`, scope: "global", adminOnly: false })
    .returning({ id: radioChannelsTable.id });
  globalChannelId = globalCh.id;

  const [adminCh] = await db
    .insert(radioChannelsTable)
    .values({ name: `${TAG} AdminsOnly`, scope: "admins", adminOnly: true })
    .returning({ id: radioChannelsTable.id });
  adminChannelId = adminCh.id;

  const [editCh] = await db
    .insert(radioChannelsTable)
    .values({ name: `${TAG} Editable`, scope: "global", adminOnly: false })
    .returning({ id: radioChannelsTable.id });
  editChannelId = editCh.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG} Client` })
    .returning({ id: clientsTable.id });
  clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId, name: `${TAG} Site` })
    .returning({ id: sitesTable.id });
  siteId = site.id;
});

afterAll(async () => {
  await db.delete(radioTransmissionsTable).where(inArray(radioTransmissionsTable.channelId, [globalChannelId, adminChannelId, editChannelId].filter(Boolean)));
  await db.delete(radioChannelsTable).where(like(radioChannelsTable.name, `${TAG}%`));
  await db.delete(sitesTable).where(inArray(sitesTable.id, [siteId].filter(Boolean)));
  await db.delete(clientsTable).where(inArray(clientsTable.id, [clientId].filter(Boolean)));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminId, officerId].filter(Boolean)));
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
});

describe("POST /radio/channels/:id/livekit-token", () => {
  it("issues a subscribe-only token to an authorised member", async () => {
    const res = await request(app)
      .post(`/api/radio/channels/${globalChannelId}/livekit-token`)
      .set(authed(officerToken));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.url).toBe(URL);
    expect(res.body.room).toBe(`radio-${globalChannelId}`);
    expect(res.body.canPublish).toBe(false);
    expect(res.body.e2eeKey).toBeTruthy();
  });

  it("denies a member who cannot access the channel (403)", async () => {
    const res = await request(app)
      .post(`/api/radio/channels/${adminChannelId}/livekit-token`)
      .set(authed(officerToken));
    expect(res.status).toBe(403);
  });

  it("requires authentication (401)", async () => {
    const res = await request(app).post(`/api/radio/channels/${globalChannelId}/livekit-token`);
    expect(res.status).toBe(401);
  });

  it("404s an unknown channel", async () => {
    const res = await request(app)
      .post(`/api/radio/channels/${randomUUID()}/livekit-token`)
      .set(authed(adminToken));
    expect(res.status).toBe(404);
  });

  it("503s when LiveKit is not configured", async () => {
    const saved = process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_URL;
    try {
      const res = await request(app)
        .post(`/api/radio/channels/${globalChannelId}/livekit-token`)
        .set(authed(officerToken));
      expect(res.status).toBe(503);
    } finally {
      process.env.LIVEKIT_URL = saved;
    }
  });
});

describe("POST /radio/channels/:id/livekit-publish-token", () => {
  it("refuses to mint a publish token without the speaker lock (409)", async () => {
    const res = await request(app)
      .post(`/api/radio/channels/${globalChannelId}/livekit-publish-token`)
      .set(authed(officerToken));
    expect(res.status).toBe(409);
  });

  it("denies an unauthorised channel before checking the lock (403)", async () => {
    const res = await request(app)
      .post(`/api/radio/channels/${adminChannelId}/livekit-publish-token`)
      .set(authed(officerToken));
    expect(res.status).toBe(403);
  });
});

describe("radio transmissions are recording-free audit metadata", () => {
  it("lists transmissions without any audio fields", async () => {
    await db.insert(radioTransmissionsTable).values({
      channelId: globalChannelId,
      speakerUserId: officerId,
      endedAt: new Date(),
      durationMs: 4200,
      endedReason: "released",
    });

    const res = await request(app)
      .get(`/api/admin/radio/channels/${globalChannelId}/transmissions`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const row = res.body[0];
    expect(row.endedReason).toBe("released");
    expect(row.durationMs).toBe(4200);
    expect(row).not.toHaveProperty("audioObjectKey");
    expect(row).not.toHaveProperty("audioMime");
    expect(row).not.toHaveProperty("audioBytes");
    expect(row).not.toHaveProperty("hasRecording");
  });

  it("no longer exposes a transmission audio playback route (404)", async () => {
    const res = await request(app)
      .get(`/api/admin/radio/transmissions/${randomUUID()}/audio`)
      .set(authed(adminToken));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/radio/channels/:id — scope/site retargeting", () => {
  it("retargets a channel to a site (adminOnly false, siteId set)", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "site", siteId });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("site");
    expect(res.body.siteId).toBe(siteId);
    expect(res.body.adminOnly).toBe(false);
  });

  it("retargets to admins-only (adminOnly true, siteId nulled)", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "admins", siteId });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("admins");
    expect(res.body.adminOnly).toBe(true);
    // siteId must be nulled for any non-site scope so a stale id can't linger.
    expect(res.body.siteId).toBeNull();
  });

  it("nulls siteId when moving to a non-site scope (global)", async () => {
    // First put it back on a site so we can prove the transition nulls siteId.
    await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "site", siteId });
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "global" });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("global");
    expect(res.body.siteId).toBeNull();
    expect(res.body.adminOnly).toBe(false);
  });

  it("rejects an invalid scope (400)", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "nonsense" });
    expect(res.status).toBe(400);
  });

  it("requires a siteId when scope=site (400)", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "site" });
    expect(res.status).toBe(400);
  });

  it("404s a site that does not exist (400 guard passes, site lookup fails)", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(adminToken))
      .send({ scope: "site", siteId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it("forbids a non-admin (403)", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${editChannelId}`)
      .set(authed(officerToken))
      .send({ scope: "global" });
    expect(res.status).toBe(403);
  });
});

describe("always-on channel designation", () => {
  // Only ONE channel may be always-on: it is the single channel a clocked-in
  // officer's phone holds open in the background, so a second one would double
  // the standing LiveKit connections the flag exists to bound.
  async function setAlwaysOn(channelId: string, alwaysOn: boolean): Promise<number> {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${channelId}`)
      .set(authed(adminToken))
      .send({ alwaysOn });
    return res.status;
  }

  async function alwaysOnIds(): Promise<string[]> {
    const rows = await db
      .select({ id: radioChannelsTable.id })
      .from(radioChannelsTable)
      .where(eq(radioChannelsTable.alwaysOn, true));
    return rows.map((r) => r.id);
  }

  it("defaults to off and can be switched on", async () => {
    const res = await request(app)
      .patch(`/api/admin/radio/channels/${globalChannelId}`)
      .set(authed(adminToken))
      .send({ alwaysOn: true });
    expect(res.status).toBe(200);
    expect(res.body.alwaysOn).toBe(true);
  });

  it("moves the flag instead of allowing two always-on channels", async () => {
    expect(await setAlwaysOn(globalChannelId, true)).toBe(200);
    expect(await setAlwaysOn(editChannelId, true)).toBe(200);
    const ids = await alwaysOnIds();
    expect(ids).toEqual([editChannelId]);
  });

  it("clears the flag on the others when a new channel is created always-on", async () => {
    expect(await setAlwaysOn(globalChannelId, true)).toBe(200);
    const created = await request(app)
      .post("/api/admin/radio/channels")
      .set(authed(adminToken))
      .send({ name: `${TAG} NewAlwaysOn`, scope: "global", alwaysOn: true });
    expect(created.status).toBe(201);
    expect(created.body.alwaysOn).toBe(true);
    expect(await alwaysOnIds()).toEqual([created.body.id]);
  });

  it("can be switched back off, leaving no always-on channel", async () => {
    expect(await setAlwaysOn(globalChannelId, true)).toBe(200);
    expect(await setAlwaysOn(globalChannelId, false)).toBe(200);
    expect(await alwaysOnIds()).toEqual([]);
  });

  it("is exposed to the officer channel list so the phone can find it", async () => {
    expect(await setAlwaysOn(globalChannelId, true)).toBe(200);
    const res = await request(app).get("/api/radio/channels").set(authed(officerToken));
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ id: string; alwaysOn?: boolean }>).find((c) => c.id === globalChannelId);
    expect(row?.alwaysOn).toBe(true);
    await setAlwaysOn(globalChannelId, false);
  });
});

describe("POST /admin/radio/channels/:id/preempt", () => {
  it("is a no-op when nobody is speaking (preempted false)", async () => {
    const res = await request(app)
      .post(`/api/admin/radio/channels/${globalChannelId}/preempt`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.preempted).toBe(false);
  });

  it("forbids a non-admin (403)", async () => {
    const res = await request(app)
      .post(`/api/admin/radio/channels/${globalChannelId}/preempt`)
      .set(authed(officerToken));
    expect(res.status).toBe(403);
  });

  it("404s an unknown channel", async () => {
    const res = await request(app)
      .post(`/api/admin/radio/channels/${randomUUID()}/preempt`)
      .set(authed(adminToken));
    expect(res.status).toBe(404);
  });

  it("requires authentication (401)", async () => {
    const res = await request(app).post(`/api/admin/radio/channels/${globalChannelId}/preempt`);
    expect(res.status).toBe(401);
  });
});

// ============================================================ WS "TAKE OVER" FAN-OUT
//
// The HTTP tests above only cover the preempt ROUTE (auth + the nobody-speaking
// no-op). They cannot see the live control-plane fan-out that makes "take over"
// actually clear the floor. This block stands up a real HTTP server with the
// radio WS gateway attached, drives an active speaker over a socket, fires the
// admin preempt via the real route, and asserts the full end-to-end contract:
//   1. the ex-speaker's OWN socket receives {type:"denied",reason:"preempted"}
//      so its client tears down publish + resets the PTT UI,
//   2. every channel subscriber (incl. the ex-speaker) receives {type:"silent"}
//      so presence clears for the whole room, and
//   3. the persisted radio_transmissions row is closed with
//      endedReason:"preempted" for the audit trail.
// A regression in preemptChannelLock / releaseLock that dropped any of these
// would otherwise pass every existing test while leaving a stuck speaker.
describe("radio 'take over' clears + notifies the previous speaker (WS end-to-end)", () => {
  let server: http.Server;
  let serverUrl = "";

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Open a radio WS and resolve once the server sends its `connected` hello. */
  function connectRadio(token: string, timeoutMs = 4000): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${serverUrl}?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error("radio ws connect timeout"));
      }, timeoutMs);
      ws.once("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connected") { clearTimeout(timer); resolve(ws); return; }
        } catch { /* ignore */ }
        clearTimeout(timer);
        reject(new Error(`unexpected first radio frame: ${data.toString()}`));
      });
      ws.once("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  /** Attach a persistent collector that records every JSON frame on a socket. */
  function collectFrames(ws: WebSocket): { frames: Array<Record<string, unknown>>; stop: () => void } {
    const frames: Array<Record<string, unknown>> = [];
    const onMsg = (data: WebSocket.RawData) => {
      try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    };
    ws.on("message", onMsg);
    return { frames, stop: () => ws.off("message", onMsg) };
  }

  /** Poll a frame buffer until one matches `pred` (or time out). */
  async function waitForFrame(
    frames: Array<Record<string, unknown>>,
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`expected frame not received; saw: ${JSON.stringify(frames)}`);
  }

  function send(ws: WebSocket, payload: object): void {
    ws.send(JSON.stringify(payload));
  }

  beforeAll(async () => {
    server = http.createServer(app);
    attachRadioWebSocketServer(server);
    server.on("upgrade", (req, socket, head) => {
      // NB: this file shadows the global `URL` with a string const, so parse
      // the pathname by hand rather than `new URL(...)`.
      const pathname = (req.url || "").split("?")[0];
      if (pathname === "/api/ws/radio") {
        handleRadioUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    serverUrl = `ws://127.0.0.1:${port}/api/ws/radio`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("notifies the ex-speaker (denied/preempted), broadcasts silent, and records endedReason=preempted", async () => {
    const officerWs = await connectRadio(officerToken);
    const adminWs = await connectRadio(adminToken);
    const officer = collectFrames(officerWs);
    const admin = collectFrames(adminWs);

    try {
      // Both sockets must be subscribers so they each receive the `silent`
      // broadcast; the officer additionally claims the floor.
      send(officerWs, { type: "join", channelId: globalChannelId });
      send(adminWs, { type: "join", channelId: globalChannelId });
      await waitForFrame(officer.frames, (m) => m.type === "joined" && m.channelId === globalChannelId);
      await waitForFrame(admin.frames, (m) => m.type === "joined" && m.channelId === globalChannelId);

      // Officer claims the speaker lock → both subscribers see `speaking`.
      send(officerWs, { type: "start", channelId: globalChannelId });
      const speaking = await waitForFrame(
        officer.frames,
        (m) => m.type === "speaking" && m.channelId === globalChannelId && m.speakerUserId === officerId,
      );
      const transmissionId = speaking.transmissionId as string;
      expect(transmissionId).toBeTruthy();

      // Admin "takes over" via the real HTTP route while the floor is held.
      const res = await request(app)
        .post(`/api/admin/radio/channels/${globalChannelId}/preempt`)
        .set(authed(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.preempted).toBe(true);
      expect(res.body.speakerUserId).toBe(officerId);

      // 1. The ex-speaker's own socket is told its floor was taken.
      const denied = await waitForFrame(
        officer.frames,
        (m) => m.type === "denied" && m.channelId === globalChannelId && m.reason === "preempted",
      );
      expect(denied.reason).toBe("preempted");

      // 2. Every subscriber (officer + admin) sees the channel go silent.
      await waitForFrame(officer.frames, (m) => m.type === "silent" && m.channelId === globalChannelId);
      await waitForFrame(admin.frames, (m) => m.type === "silent" && m.channelId === globalChannelId);

      // 3. The transmission row is closed with the preempted reason. The DB
      //    write in releaseLock is awaited before `silent` broadcasts, but
      //    poll briefly to stay immune to any scheduling jitter.
      let row: { endedReason: string | null; endedAt: Date | null } | undefined;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        [row] = await db
          .select({ endedReason: radioTransmissionsTable.endedReason, endedAt: radioTransmissionsTable.endedAt })
          .from(radioTransmissionsTable)
          .where(eq(radioTransmissionsTable.id, transmissionId))
          .limit(1);
        if (row?.endedReason) break;
        await sleep(20);
      }
      expect(row?.endedReason).toBe("preempted");
      expect(row?.endedAt).toBeTruthy();
    } finally {
      officer.stop();
      admin.stop();
      for (const ws of [officerWs, adminWs]) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  });

  // Live roster nudge: an admin creating/archiving a channel over the REST
  // admin routes must push {type:"channels_changed"} to every connected radio
  // socket so a dispatcher who keeps the Radio tab open sees the new/removed
  // site channel without navigating away (the client refetches on the nudge).
  it("broadcasts channels_changed to connected sockets on admin create/archive/delete", async () => {
    const officerWs = await connectRadio(officerToken);
    const officer = collectFrames(officerWs);
    try {
      // CREATE
      const created = await request(app)
        .post("/api/admin/radio/channels")
        .set(authed(adminToken))
        .send({ name: "Nudge Test Channel", scope: "global" });
      expect(created.status).toBe(201);
      await waitForFrame(officer.frames, (m) => m.type === "channels_changed");

      // ARCHIVE (PATCH)
      officer.frames.length = 0;
      const archived = await request(app)
        .patch(`/api/admin/radio/channels/${created.body.id}`)
        .set(authed(adminToken))
        .send({ archived: true });
      expect(archived.status).toBe(200);
      await waitForFrame(officer.frames, (m) => m.type === "channels_changed");

      // DELETE
      officer.frames.length = 0;
      const deleted = await request(app)
        .delete(`/api/admin/radio/channels/${created.body.id}`)
        .set(authed(adminToken));
      expect(deleted.status).toBe(204);
      await waitForFrame(officer.frames, (m) => m.type === "channels_changed");
    } finally {
      officer.stop();
      try { officerWs.terminate(); } catch { /* ignore */ }
    }
  });
});
