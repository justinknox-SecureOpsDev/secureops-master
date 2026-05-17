import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "http";
import { eq, sql, and, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  revokedTokensTable,
  radioChannelsTable,
  radioTransmissionsTable,
  licensesTable,
  sitesTable,
  shiftsTable,
  auditLogsTable,
  type RadioChannel,
} from "@workspace/db";
import { verifyToken } from "../middlewares/auth";
import { logger } from "./logger";

/**
 * Live push-to-talk radio gateway.
 *
 * One process-local WebSocketServer mounted at `/api/ws/radio?token=<jwt>`.
 *
 * Wire protocol (all control frames are JSON, audio is binary):
 *
 *   client → server (JSON text frames):
 *     {type:"join",   channelId}            // subscribe to a channel
 *     {type:"leave",  channelId}            // unsubscribe
 *     {type:"start",  channelId}            // claim the speaker lock
 *     {type:"end",    channelId}            // release the speaker lock
 *     {type:"ping"}                         // keepalive
 *
 *   client → server (binary frames):
 *     Raw audio chunk for the channel the client currently holds the
 *     speaker lock on. Format is chosen by the client (e.g. opus-in-webm
 *     timeslices from MediaRecorder); the gateway treats payloads as
 *     opaque bytes and only fans them out.
 *
 *   server → client (JSON):
 *     {type:"joined",   channelId}
 *     {type:"left",     channelId}
 *     {type:"speaking", channelId, speakerUserId, speakerName, transmissionId}
 *     {type:"silent",   channelId}
 *     {type:"denied",   channelId, reason}
 *     {type:"error",    message}
 *
 *   server → client (binary):
 *     Audio chunk. First byte is the length of a UTF-8 channelId
 *     prefix; the rest is the audio payload. This lets one socket
 *     multiplex audio from several joined channels without an extra
 *     control frame per chunk.
 *
 * Single-speaker lock per channel is in-memory; the server is the
 * single source of truth (`/start` either wins atomically or is denied).
 * Locks are also auto-released on socket disconnect and after a max
 * continuous transmission of MAX_TRANSMISSION_MS.
 *
 * Audio payloads are NEVER persisted — only a `radio_transmissions` row
 * per claim/release for audit.
 */

const MAX_TRANSMISSION_MS = 60_000;
const MAX_FRAME_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30_000;

// Per-user join rate-limit: window length and max joins in that window.
// A reasonable human flips between maybe 4–5 channels in a minute; we
// allow 30 join attempts per minute per user to absorb client retries
// (e.g. reconnect bursts) while preventing membership-enumeration loops.
const JOIN_WINDOW_MS = 60_000;
const JOIN_WINDOW_MAX = 30;

interface RadioSocket extends WebSocket {
  userId?: string;
  userRole?: string;
  userName?: string;
  userEmail?: string;
  authenticated?: boolean;
  /** Control frames received before auth completed; drained on auth. */
  pendingMessages?: Array<{ data: Buffer | string; isBinary: boolean }>;
  joinedChannels?: Set<string>;
  isAlive?: boolean;
  joinTimestamps?: number[];
}

type SpeakerLock = {
  speakerUserId: string;
  speakerName: string;
  speakerEmail: string | null;
  speakerRole: string | null;
  socket: RadioSocket;
  transmissionId: string;
  startedAt: Date;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

// channelId → connected sockets that have joined it
const channelSubscribers = new Map<string, Set<RadioSocket>>();
// channelId → current speaker lock (if any)
const channelLocks = new Map<string, SpeakerLock>();
// userId → set of sockets (handy for force-disconnect if ever needed)
const userSockets = new Map<string, Set<RadioSocket>>();

let radioWss: WebSocketServer | null = null;

function trackJoinRate(socket: RadioSocket): boolean {
  const now = Date.now();
  const stamps = socket.joinTimestamps ?? [];
  const recent = stamps.filter((t) => now - t < JOIN_WINDOW_MS);
  if (recent.length >= JOIN_WINDOW_MAX) {
    socket.joinTimestamps = recent;
    return false;
  }
  recent.push(now);
  socket.joinTimestamps = recent;
  return true;
}

async function loadChannel(channelId: string): Promise<RadioChannel | null> {
  const [row] = await db
    .select()
    .from(radioChannelsTable)
    .where(eq(radioChannelsTable.id, channelId))
    .limit(1);
  return row ?? null;
}

/**
 * Decide whether a given user may join (read + speak on) a channel.
 * Mirrors the REST visibility filter so the WS path can never be a
 * back-door past role/scope checks.
 */
export async function canAccessChannel(
  userId: string,
  userRole: string,
  channel: RadioChannel,
): Promise<boolean> {
  if (channel.archivedAt) return false;
  if (channel.adminOnly && userRole !== "admin") return false;
  if (userRole === "admin") return true; // admins see everything non-archived

  switch (channel.scope) {
    case "global":
      return true;
    case "all_officers":
      return true; // every active employee qualifies
    case "admins":
      return false; // already short-circuited for admins above
    case "site": {
      if (!channel.siteId) return false;
      const [{ minLevel }] = (await db.execute(sql`
        SELECT COALESCE(MIN(required_license_level), 2)::int AS "minLevel"
        FROM shifts WHERE site_id = ${channel.siteId}
      `)).rows as { minLevel: number }[];
      const today = new Date();
      const [row] = await db
        .select({ maxLevel: sql<number>`MAX(${licensesTable.level})::int` })
        .from(licensesTable)
        .where(and(
          eq(licensesTable.employeeId, userId),
          sql`${licensesTable.expiryDate} >= ${today}`,
        ))
        .groupBy(licensesTable.employeeId);
      return (row?.maxLevel ?? 0) >= (minLevel ?? 2);
    }
    default:
      return false;
  }
}

/**
 * REST helper used by /radio/channels — returns every channel the user
 * is eligible to see, with the site name expanded.
 */
export async function listChannelsForUser(
  userId: string,
  userRole: string,
): Promise<Array<RadioChannel & { siteName: string | null }>> {
  const rows = await db
    .select({
      id: radioChannelsTable.id,
      name: radioChannelsTable.name,
      scope: radioChannelsTable.scope,
      siteId: radioChannelsTable.siteId,
      adminOnly: radioChannelsTable.adminOnly,
      slug: radioChannelsTable.slug,
      archivedAt: radioChannelsTable.archivedAt,
      createdAt: radioChannelsTable.createdAt,
      siteName: sitesTable.name,
    })
    .from(radioChannelsTable)
    .leftJoin(sitesTable, eq(sitesTable.id, radioChannelsTable.siteId));

  const out: Array<RadioChannel & { siteName: string | null }> = [];
  for (const r of rows) {
    const channel = r as unknown as RadioChannel;
    if (await canAccessChannel(userId, userRole, channel)) {
      out.push({ ...channel, siteName: r.siteName ?? null });
    }
  }
  return out;
}

function addSubscriber(channelId: string, socket: RadioSocket): void {
  let set = channelSubscribers.get(channelId);
  if (!set) { set = new Set(); channelSubscribers.set(channelId, set); }
  set.add(socket);
  if (!socket.joinedChannels) socket.joinedChannels = new Set();
  socket.joinedChannels.add(channelId);
}

function removeSubscriber(channelId: string, socket: RadioSocket): void {
  const set = channelSubscribers.get(channelId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) channelSubscribers.delete(channelId);
  socket.joinedChannels?.delete(channelId);
}

function sendJson(socket: RadioSocket, payload: object): void {
  if (socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }
}

function broadcastJson(channelId: string, payload: object, except?: RadioSocket): void {
  const subs = channelSubscribers.get(channelId);
  if (!subs) return;
  const msg = JSON.stringify(payload);
  for (const s of subs) {
    if (s === except) continue;
    if (s.readyState === WebSocket.OPEN) {
      try { s.send(msg); } catch { /* ignore */ }
    }
  }
}

/**
 * Fan out a binary audio chunk to every subscriber of `channelId`
 * except the speaker. The payload is wrapped with a 1-byte channelId
 * length + UTF-8 channelId prefix so clients receiving from multiple
 * channels can route the bytes correctly.
 */
function broadcastAudio(channelId: string, payload: Buffer, except: RadioSocket): void {
  const subs = channelSubscribers.get(channelId);
  if (!subs) return;
  const idBuf = Buffer.from(channelId, "utf8");
  if (idBuf.length > 255) return; // defensive — channel UUIDs are ~36
  const framed = Buffer.concat([Buffer.from([idBuf.length]), idBuf, payload]);
  for (const s of subs) {
    if (s === except) continue;
    if (s.readyState === WebSocket.OPEN) {
      try { s.send(framed, { binary: true }); } catch { /* ignore */ }
    }
  }
}

async function writeAudit(params: {
  action: "radio.transmit_start" | "radio.transmit_end";
  actorUserId: string;
  actorEmail: string | null;
  actorRole: string | null;
  channelId: string;
  transmissionId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      actorUserId: params.actorUserId,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      action: params.action,
      targetTable: "radio_transmissions",
      targetId: params.transmissionId,
      method: "WS",
      path: `/api/ws/radio/${params.channelId}`,
      statusCode: 200,
      ip: null,
      userAgent: null,
      before: null,
      after: null,
      metadata: { channelId: params.channelId, ...(params.metadata ?? {}) },
    });
  } catch (err) {
    logger.warn({ err }, "[radio] failed to write audit log entry");
  }
}

async function releaseLock(channelId: string, reason: "released" | "timeout" | "disconnect" | "preempted"): Promise<void> {
  const lock = channelLocks.get(channelId);
  if (!lock) return;
  channelLocks.delete(channelId);
  clearTimeout(lock.timeoutHandle);

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - lock.startedAt.getTime();
  try {
    await db
      .update(radioTransmissionsTable)
      .set({ endedAt, durationMs, endedReason: reason })
      .where(eq(radioTransmissionsTable.id, lock.transmissionId));
  } catch (err) {
    logger.warn({ err, channelId, transmissionId: lock.transmissionId }, "[radio] failed to close transmission row");
  }

  // Audit every transmission close — speaker, channel, duration, reason.
  void writeAudit({
    action: "radio.transmit_end",
    actorUserId: lock.speakerUserId,
    actorEmail: lock.speakerEmail,
    actorRole: lock.speakerRole,
    channelId,
    transmissionId: lock.transmissionId,
    metadata: { durationMs, endedReason: reason },
  });

  broadcastJson(channelId, { type: "silent", channelId });
}

async function claimLock(channelId: string, socket: RadioSocket): Promise<void> {
  const userId = socket.userId!;
  const userName = socket.userName ?? "Unknown";

  const existing = channelLocks.get(channelId);
  if (existing) {
    if (existing.speakerUserId === userId) {
      // already speaking — idempotent
      sendJson(socket, {
        type: "speaking", channelId,
        speakerUserId: existing.speakerUserId,
        speakerName: existing.speakerName,
        transmissionId: existing.transmissionId,
      });
      return;
    }
    sendJson(socket, { type: "denied", channelId, reason: "busy", speakerName: existing.speakerName });
    return;
  }

  const startedAt = new Date();
  const [row] = await db
    .insert(radioTransmissionsTable)
    .values({ channelId, speakerUserId: userId, startedAt })
    .returning({ id: radioTransmissionsTable.id });
  if (!row) {
    sendJson(socket, { type: "denied", channelId, reason: "server" });
    return;
  }

  const timeoutHandle = setTimeout(() => {
    void releaseLock(channelId, "timeout");
  }, MAX_TRANSMISSION_MS);

  const lock: SpeakerLock = {
    speakerUserId: userId,
    speakerName: userName,
    speakerEmail: socket.userEmail ?? null,
    speakerRole: socket.userRole ?? null,
    socket,
    transmissionId: row.id,
    startedAt,
    timeoutHandle,
  };
  channelLocks.set(channelId, lock);

  // Audit every successful transmission start — non-blocking.
  void writeAudit({
    action: "radio.transmit_start",
    actorUserId: userId,
    actorEmail: socket.userEmail ?? null,
    actorRole: socket.userRole ?? null,
    channelId,
    transmissionId: row.id,
  });

  broadcastJson(channelId, {
    type: "speaking", channelId,
    speakerUserId: userId,
    speakerName: userName,
    transmissionId: row.id,
  });
}

async function handleControl(socket: RadioSocket, raw: string): Promise<void> {
  let msg: { type?: string; channelId?: string };
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "ping") {
    sendJson(socket, { type: "pong" });
    return;
  }

  const channelId = typeof msg.channelId === "string" ? msg.channelId : null;
  if (!channelId) { sendJson(socket, { type: "error", message: "channelId required" }); return; }

  if (msg.type === "join") {
    if (!trackJoinRate(socket)) {
      sendJson(socket, { type: "denied", channelId, reason: "rate_limited" });
      return;
    }
    const channel = await loadChannel(channelId);
    if (!channel) { sendJson(socket, { type: "denied", channelId, reason: "not_found" }); return; }
    if (!(await canAccessChannel(socket.userId!, socket.userRole!, channel))) {
      sendJson(socket, { type: "denied", channelId, reason: "forbidden" });
      return;
    }
    addSubscriber(channelId, socket);
    sendJson(socket, { type: "joined", channelId });
    const lock = channelLocks.get(channelId);
    if (lock) {
      sendJson(socket, {
        type: "speaking", channelId,
        speakerUserId: lock.speakerUserId,
        speakerName: lock.speakerName,
        transmissionId: lock.transmissionId,
      });
    }
    return;
  }

  if (msg.type === "leave") {
    // releasing the lock is implicit if they were speaking
    const lock = channelLocks.get(channelId);
    if (lock && lock.socket === socket) await releaseLock(channelId, "released");
    removeSubscriber(channelId, socket);
    sendJson(socket, { type: "left", channelId });
    return;
  }

  if (msg.type === "start") {
    if (!socket.joinedChannels?.has(channelId)) {
      sendJson(socket, { type: "denied", channelId, reason: "not_joined" });
      return;
    }
    await claimLock(channelId, socket);
    return;
  }

  if (msg.type === "end") {
    const lock = channelLocks.get(channelId);
    if (lock && lock.socket === socket) await releaseLock(channelId, "released");
    return;
  }
}

function handleBinary(socket: RadioSocket, data: Buffer): void {
  if (data.byteLength === 0 || data.byteLength > MAX_FRAME_BYTES) return;
  // Speaker can only push to whichever channel they currently hold a lock on.
  for (const [channelId, lock] of channelLocks) {
    if (lock.socket === socket && lock.speakerUserId === socket.userId) {
      broadcastAudio(channelId, data, socket);
      return;
    }
  }
  // Not holding any lock → silently drop. Cheaper than echoing an error
  // per frame in the (common) race where a frame lands after release.
}

function onSocketClose(socket: RadioSocket): void {
  const userId = socket.userId;
  if (!userId) return;
  // Release every channel this socket was speaking on.
  const lockedChannels: string[] = [];
  for (const [channelId, lock] of channelLocks) {
    if (lock.socket === socket) lockedChannels.push(channelId);
  }
  for (const channelId of lockedChannels) {
    void releaseLock(channelId, "disconnect");
  }
  // Drop subscriptions.
  if (socket.joinedChannels) {
    for (const channelId of [...socket.joinedChannels]) {
      removeSubscriber(channelId, socket);
    }
  }
  const set = userSockets.get(userId);
  if (set) {
    set.delete(socket);
    if (set.size === 0) userSockets.delete(userId);
  }
}

export function attachRadioWebSocketServer(server: Server): void {
  radioWss = new WebSocketServer({ server, path: "/api/ws/radio" });

  const heartbeat = setInterval(() => {
    radioWss!.clients.forEach((ws) => {
      const sock = ws as RadioSocket;
      if (!sock.isAlive) { sock.terminate(); return; }
      sock.isAlive = false;
      try { sock.ping(); } catch { /* ignore */ }
    });
  }, HEARTBEAT_MS);

  radioWss.on("close", () => clearInterval(heartbeat));

  radioWss.on("connection", (ws: RadioSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) { ws.close(1008, "Token required"); return; }

    let payload: { userId: string; role: string; email: string; jti?: string; iat?: number };
    try { payload = verifyToken(token); }
    catch { ws.close(1008, "Invalid token"); return; }

    // Attach the message handler IMMEDIATELY so any frames arriving while
    // the async auth check is still running are buffered (not dropped).
    // The handler drops everything until `authenticated` flips true; once
    // auth completes we drain `pendingMessages` in order.
    ws.authenticated = false;
    ws.pendingMessages = [];
    ws.isAlive = true;
    ws.joinedChannels = new Set();
    ws.joinTimestamps = [];

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!ws.authenticated) {
        // Cap buffered frames so a malicious pre-auth client can't
        // exhaust memory; 32 control messages is generous given a
        // typical reconnect sends 2–3 joins + maybe a start.
        if ((ws.pendingMessages?.length ?? 0) < 32) {
          ws.pendingMessages!.push({ data: isBinary ? buf : buf.toString("utf8"), isBinary });
        }
        return;
      }
      if (isBinary) {
        handleBinary(ws, buf);
      } else {
        const text = typeof data === "string" ? data : buf.toString("utf8");
        void handleControl(ws, text);
      }
    });
    ws.on("close", () => onSocketClose(ws));
    ws.on("error", (err) => logger.warn({ err, userId: payload.userId }, "[radio] WS error"));

    // Mirror the wsManager auth pattern: re-check user status, watermark
    // and revoked-jti before letting the socket establish.
    Promise.all([
      db.select({
        id: usersTable.id,
        role: usersTable.role,
        status: usersTable.status,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        tokensValidAfter: usersTable.tokensValidAfter,
        mustChangePassword: usersTable.mustChangePassword,
      })
        .from(usersTable)
        .where(eq(usersTable.id, payload.userId))
        .limit(1),
      payload.jti
        ? db.select({ jti: revokedTokensTable.jti })
            .from(revokedTokensTable)
            .where(inArray(revokedTokensTable.jti, [payload.jti]))
            .limit(1)
        : Promise.resolve([] as { jti: string }[]),
    ])
      .then(([[user], revokedRows]) => {
        if (!user || user.status !== "active") { ws.close(1008, "Account is not active"); return; }
        const iatMs = (payload.iat ?? 0) * 1000;
        if (iatMs < user.tokensValidAfter.getTime()) { ws.close(1008, "Session was revoked"); return; }
        if (revokedRows.length > 0) { ws.close(1008, "Session was revoked"); return; }
        if (user.mustChangePassword) { ws.close(1008, "Password change required"); return; }
        if (ws.readyState !== WebSocket.OPEN) return;

        ws.userId = user.id;
        ws.userRole = user.role;
        ws.userName = `${user.firstName} ${user.lastName}`;
        ws.userEmail = payload.email;

        let set = userSockets.get(user.id);
        if (!set) { set = new Set(); userSockets.set(user.id, set); }
        set.add(ws);

        // Flip the gate, THEN drain. Anything that arrives mid-drain
        // is processed in order via the same handler.
        ws.authenticated = true;
        const pending = ws.pendingMessages ?? [];
        ws.pendingMessages = [];
        for (const p of pending) {
          if (p.isBinary) handleBinary(ws, p.data as Buffer);
          else void handleControl(ws, p.data as string);
        }

        sendJson(ws, { type: "connected", userId: user.id });
      })
      .catch((err) => {
        logger.error({ err }, "[radio] WS auth DB check failed");
        ws.close(1011, "Authentication error");
      });
  });

  logger.info("Radio WebSocket server attached at /api/ws/radio");
}

export function getRadioWss(): WebSocketServer | null { return radioWss; }
