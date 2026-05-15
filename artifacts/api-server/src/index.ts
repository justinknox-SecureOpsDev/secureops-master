import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketServer } from "./lib/wsManager";
import { seedPolicies, backfillEmployeeProfileFields } from "@workspace/db";

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
});

seedPolicies()
  .then(() => logger.info("Default policies ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed default policies"));

// One-time backfill of applicant + onboarding fields onto employees rows.
// Idempotent (COALESCE-only): safe to run on every boot.
backfillEmployeeProfileFields()
  .then(() => logger.info("Employee profile backfill complete"))
  .catch((err) => logger.error({ err }, "Failed to backfill employee profile fields"));

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
