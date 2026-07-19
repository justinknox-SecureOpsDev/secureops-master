import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import type { Duplex } from "stream";
import { eq } from "drizzle-orm";
import { db, usersTable, revokedTokensTable } from "@workspace/db";
import { verifyToken } from "../middlewares/auth";
import { logger } from "./logger";

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  userName?: string;
  role?: string;
  isAlive?: boolean;
}

// userId -> set of sockets (one user may have multiple tabs)
const connections = new Map<string, Set<AuthenticatedSocket>>();

let wss: WebSocketServer | null = null;

export function getWss() { return wss; }

/**
 * Forcibly close every open WebSocket for a given user.
 *
 * Call this immediately after bumping tokensValidAfter or revoking individual
 * tokens so that already-connected sockets are cut off in real time rather
 * than left open until natural expiry. The client will reconnect with its
 * stored token, which will then fail the revocation check and be closed again.
 */
export function disconnectUser(userId: string): void {
  const sockets = connections.get(userId);
  if (!sockets) return;
  for (const ws of sockets) {
    try {
      ws.close(1008, "Session was revoked");
    } catch {
      // ignore — socket may already be closing
    }
  }
}

/**
 * Send a payload to every socket of every authorized recipient.
 *
 * - `allowedUserIds`: required allow-list of user IDs that may receive the
 *   message. If omitted, the message is broadcast to every authenticated
 *   connection that passes the `staffOnly` filter (see below).
 *   Pass an explicit Set for any private-room broadcast (direct messages,
 *   shift channels, etc.) so non-members never see the payload.
 * - `excludeUserId`: optional sender ID to skip (typically the message author
 *   already has the message in their REST response).
 * - `staffOnly`: when true, skip sockets belonging to users with role=`client`.
 *   Must be set for any internal channel (e.g. announcements) that should
 *   not fan out to external client-portal connections.
 *
 * The `roomId` parameter is retained for logging/observability but is NOT
 * used to look up membership — callers must compute the recipient set.
 */
export function broadcastToRoom(
  _roomId: string,
  payload: object,
  opts: { excludeUserId?: string; allowedUserIds?: ReadonlySet<string>; staffOnly?: boolean } = {},
) {
  const msg = JSON.stringify(payload);
  const { excludeUserId, allowedUserIds, staffOnly } = opts;
  for (const [userId, sockets] of connections.entries()) {
    if (excludeUserId && userId === excludeUserId) continue;
    if (allowedUserIds && !allowedUserIds.has(userId)) continue;
    for (const ws of sockets) {
      if (staffOnly && ws.role === "client") continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}

export function getConnectedUserIds(): ReadonlySet<string> {
  return new Set(connections.keys());
}

export function sendToUser(userId: string, payload: object) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function attachWebSocketServer(server: Server) {
  // IMPORTANT: use `noServer:true` so this server does NOT register its own
  // `upgrade` listener on the http.Server. We share that http.Server with the
  // radio gateway; if both attached via `{server,path}` the first one to run
  // would call `abortHandshake(socket,400)` on every path it did not own —
  // which silently killed the radio WS upgrade in production. The single
  // upgrade dispatcher in `index.ts` routes by pathname instead.
  wss = new WebSocketServer({ noServer: true });

  // Heartbeat to clean dead connections
  const heartbeat = setInterval(() => {
    wss!.clients.forEach((ws) => {
      const socket = ws as AuthenticatedSocket;
      if (!socket.isAlive) { socket.terminate(); return; }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws: AuthenticatedSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) { ws.close(1008, "Token required"); return; }

    type WsTokenPayload = { userId: string; role: string; email: string; jti?: string; iat?: number; scope?: string };
    let payload: WsTokenPayload;
    try {
      payload = verifyToken(token) as WsTokenPayload;
    } catch {
      ws.close(1008, "Invalid token");
      return;
    }

    // Reject scope-limited tokens (e.g. "pdf-download"). Only full session
    // JWTs — which carry no `scope` field — may open a WebSocket session.
    if (payload.scope) {
      ws.close(1008, "Scoped tokens cannot open a WebSocket session");
      return;
    }

    const tokenPayload = payload;

    // Re-validate against current DB state so stale tokens from deactivated or
    // demoted accounts cannot open a WebSocket session. We also enforce the
    // same revocation semantics as the HTTP requireAuth middleware:
    //   - tokens_valid_after watermark (logout-all / admin revoke-sessions)
    //   - revoked_tokens jti lookup (single-session logout)
    //   - mustChangePassword lockout (mirrors the HTTP layer's gate)
    // Without these, a revoked JWT would still establish a long-lived WS
    // and continue receiving chat / live-ops broadcasts until token expiry.
    Promise.all([
      db.select({
        id: usersTable.id,
        role: usersTable.role,
        status: usersTable.status,
        tokensValidAfter: usersTable.tokensValidAfter,
        mustChangePassword: usersTable.mustChangePassword,
      })
        .from(usersTable)
        .where(eq(usersTable.id, tokenPayload.userId))
        .limit(1),
      tokenPayload.jti
        ? db.select({ jti: revokedTokensTable.jti })
            .from(revokedTokensTable)
            .where(eq(revokedTokensTable.jti, tokenPayload.jti))
            .limit(1)
        : Promise.resolve([] as { jti: string }[]),
    ])
      .then(([[user], revokedRows]) => {
        if (!user || user.status !== "active") {
          ws.close(1008, "Account is not active");
          return;
        }
        const iatMs = (tokenPayload.iat ?? 0) * 1000;
        if (iatMs < user.tokensValidAfter.getTime()) {
          ws.close(1008, "Session was revoked");
          return;
        }
        if (revokedRows.length > 0) {
          ws.close(1008, "Session was revoked");
          return;
        }
        // Mirror the HTTP mustChangePassword lockout: users with a forced
        // password rotation pending must not receive chat / live-ops traffic
        // until they complete credential rotation.
        if (user.mustChangePassword) {
          ws.close(1008, "Password change required");
          return;
        }

        // Guard against the race where the client disconnected before the DB
        // query resolved; don't insert a dead socket into the registry.
        if (ws.readyState !== WebSocket.OPEN) return;

        ws.userId = user.id;
        ws.role = user.role; // live role, not stale token role
        ws.isAlive = true;

        if (!connections.has(user.id)) {
          connections.set(user.id, new Set());
        }
        connections.get(user.id)!.add(ws);

        logger.info({ userId: user.id }, "WS client connected");

        ws.on("pong", () => { ws.isAlive = true; });

        ws.on("message", (data) => {
          // Clients can send {type: "ping"} keepalives — nothing else needed, server handles broadcasts
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
          } catch { /* ignore */ }
        });

        ws.on("close", () => {
          connections.get(user.id)?.delete(ws);
          if (connections.get(user.id)?.size === 0) {
            connections.delete(user.id);
          }
        });

        ws.on("error", (err) => logger.error({ err, userId: user.id }, "WS error"));

        ws.send(JSON.stringify({ type: "connected", userId: user.id }));
      })
      .catch((err) => {
        logger.error({ err, userId: tokenPayload.userId }, "WS auth DB check failed");
        ws.close(1011, "Authentication error");
      });
  });

  logger.info("WebSocket server attached at /api/ws");
}

/**
 * Manually dispatch an `upgrade` event to the chat WS server. Called by the
 * single `server.on('upgrade')` dispatcher in `index.ts` after it has
 * matched the request pathname to `/api/ws`.
 */
export function handleChatUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!wss) { socket.destroy(); return; }
  // Guard the raw socket during the handshake — an abort here would
  // otherwise emit an unhandled 'error' and crash the process.
  socket.on("error", (err) => {
    logger.warn({ err }, "Chat WS handshake socket error");
    socket.destroy();
  });
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss!.emit("connection", ws, req);
  });
}
