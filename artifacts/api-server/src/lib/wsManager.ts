import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
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

    ws.userId = payload.userId;
    ws.role = payload.role;
    ws.isAlive = true;

    if (!connections.has(payload.userId)) {
      connections.set(payload.userId, new Set());
    }
    connections.get(payload.userId)!.add(ws);

    logger.info({ userId: payload.userId }, "WS client connected");

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (data) => {
      // Clients can send {type: "ping"} keepalives — nothing else needed, server handles broadcasts
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch { /* ignore */ }
    });

    ws.on("close", () => {
      if (ws.userId) {
        connections.get(ws.userId)?.delete(ws);
        if (connections.get(ws.userId)?.size === 0) {
          connections.delete(ws.userId);
        }
      }
    });

    ws.on("error", (err) => logger.error({ err, userId: ws.userId }, "WS error"));

    // Welcome
    ws.send(JSON.stringify({ type: "connected", userId: payload.userId }));
  });

  logger.info("WebSocket server attached at /api/ws");
}
