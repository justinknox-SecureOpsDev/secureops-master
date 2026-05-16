import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketServer } from "./lib/wsManager";
import { seedPolicies, backfillEmployeeProfileFields } from "@workspace/db";
import { seedDemoUsers } from "./lib/seedDemoUsers";

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

server.listen(port, () => {
  logger.info({ port }, "Server listening");
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

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
