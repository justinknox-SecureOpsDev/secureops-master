import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
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
 * Send a payload to every socket of every authorized recipient.
 *
 * - `allowedUserIds`: required allow-list of user IDs that may receive the
 *   message. If omitted (legacy callers), the message is treated as
 *   public-room traffic and broadcast to every authenticated connection.
 *   Pass an explicit Set for any private-room broadcast (direct messages,
 *   shift channels, etc.) so non-members never see the payload.
 * - `excludeUserId`: optional sender ID to skip (typically the message author
 *   already has the message in their REST response).
 *
 * The `roomId` parameter is retained for logging/observability but is NOT
 * used to look up membership — callers must compute the recipient set.
 */
export function broadcastToRoom(
  _roomId: string,
  payload: object,
  opts: { excludeUserId?: string; allowedUserIds?: ReadonlySet<string> } = {},
) {
  const msg = JSON.stringify(payload);
  const { excludeUserId, allowedUserIds } = opts;
  for (const [userId, sockets] of connections.entries()) {
    if (excludeUserId && userId === excludeUserId) continue;
    if (allowedUserIds && !allowedUserIds.has(userId)) continue;
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
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
  wss = new WebSocketServer({ server, path: "/api/ws" });

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

    let payload: { userId: string; role: string; email: string } | null = null;
    try {
      payload = verifyToken(token);
    } catch {
      ws.close(1008, "Invalid token");
      return;
    }

    const tokenPayload = payload;

    // Re-validate against current DB state so stale tokens from deactivated or
    // demoted accounts cannot open a WebSocket session. All event handlers are
    // registered inside the .then() callback so the socket is never added to
    // `connections` if it closed before the query returned.
    db.select({ id: usersTable.id, role: usersTable.role, status: usersTable.status })
      .from(usersTable)
      .where(eq(usersTable.id, tokenPayload.userId))
      .limit(1)
      .then(([user]) => {
        if (!user || user.status !== "active") {
          ws.close(1008, "Account is not active");
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
