import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketServer, handleChatUpgrade } from "./lib/wsManager";
import { attachRadioWebSocketServer, handleRadioUpgrade } from "./lib/radioGateway";
import { seedPolicies, backfillEmployeeProfileFields } from "@workspace/db";
import { seedDemoUsers } from "./lib/seedDemoUsers";
import { seedChatRooms } from "./lib/seedChatRooms";
import { seedRadioChannels } from "./lib/seedRadioChannels";
import { startScheduledJobs } from "./lib/scheduledJobs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);
attachWebSocketServer(server);
attachRadioWebSocketServer(server);

// Single upgrade dispatcher. Both WS servers are created with
// `noServer:true` so they don't fight over the http.Server's `upgrade`
// event (when both attach via `{server,path}` the loser's handler calls
// `abortHandshake(socket,400)` and silently kills the other path's
// upgrade — that bug broke /api/ws/radio in production). Route by
// pathname here; unknown paths get a clean 404.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "", "http://localhost");
  if (url.pathname === "/api/ws") {
    handleChatUpgrade(req, socket, head);
  } else if (url.pathname === "/api/ws/radio") {
    handleRadioUpgrade(req, socket, head);
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
  // Background maintenance — currently just expired-revoked-token cleanup.
  // Kept inside listen() so it only starts once the server is actually up.
  startScheduledJobs();
  // Production startup checks — surface degraded-mode configuration loudly
  // so operators notice on the very first deploy log instead of after a
  // user-facing failure (e.g. invite emails silently not being sent).
  if (process.env.NODE_ENV === "production") {
    const smtpOk = Boolean(
      process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS,
    );
    if (!smtpOk) {
      logger.error(
        "SMTP is not configured in production. Invite, onboarding, password-reset and amendment emails will NOT be sent. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optionally SMTP_FROM) to enable email delivery.",
      );
    }
    if (!process.env.APP_BASE_URL && !process.env.REPLIT_DOMAINS) {
      logger.error(
        "Neither APP_BASE_URL nor REPLIT_DOMAINS is set. Password-reset, onboarding and amendment links cannot be built — emails relying on those URLs will be skipped.",
      );
    }
    if (!process.env.ALLOWED_ORIGINS && !process.env.REPLIT_DOMAINS) {
      logger.error(
        "No CORS origins configured (ALLOWED_ORIGINS / REPLIT_DOMAINS). Browser clients will be blocked.",
      );
    }
  }
});

seedPolicies()
  .then(() => logger.info("Default policies ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed default policies"));

// One-time backfill of applicant + onboarding fields onto employees rows.
// Idempotent (COALESCE-only): safe to run on every boot.
backfillEmployeeProfileFields()
  .then(() => logger.info("Employee profile backfill complete"))
  .catch((err) => logger.error({ err }, "Failed to backfill employee profile fields"));

// Idempotently provision the documented demo accounts so `replit.md`
// credentials always work. Disable with SEED_DEMO_USERS=false.
seedDemoUsers()
  .then(() => logger.info("Demo users ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed demo users"));

// Idempotently seed the canonical chat channel set (announcements,
// per-license-level rooms, OPS, city rooms, elite, one-per-site).
seedChatRooms()
  .then(() => logger.info("Canonical chat rooms ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed canonical chat rooms"));

seedRadioChannels()
  .then(() => logger.info("Default radio channels ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed default radio channels"));

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
