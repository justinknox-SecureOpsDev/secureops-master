import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachWebSocketServer, handleChatUpgrade, getWss } from "./lib/wsManager";
import { attachRadioWebSocketServer, handleRadioUpgrade, getRadioWss } from "./lib/radioGateway";
import { seedPolicies, backfillEmployeeProfileFields, backfillMustSignPolicies, pool } from "@workspace/db";
import { seedDemoUsers, ensureAdminAccountHealth, ensureEmployeesRowsForAllUsers, backfillUserPhoneNumbersFromEmployees, migrateLeadRoleToSiteManager, backfillBillingEmail } from "./lib/seedDemoUsers";
import { seedChatRooms } from "./lib/seedChatRooms";
import { seedRadioChannels } from "./lib/seedRadioChannels";
import { startScheduledJobs } from "./lib/scheduledJobs";
import { initConfigReadiness } from "./lib/configReadiness";
import { loadConfirmEditWindowConfigFromDb } from "./lib/confirmEditWindowConfig";
import { restoreStrandedOnboardingApplicants } from "./lib/restoreStrandedOnboarding";

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
  // Attach an error listener BEFORE the handshake. A client that aborts
  // mid-upgrade (mobile network blip, navigate-away, ECONNRESET) makes the
  // raw socket emit 'error'. With no listener, Node treats it as an
  // uncaught exception and kills the whole process — a brief, random
  // production outage. Handling it here keeps the server up.
  socket.on("error", (err) => {
    logger.warn({ err }, "WS upgrade socket error");
    socket.destroy();
  });
  // Contain any synchronous throw (URL parsing, handshake) to this socket so
  // it can never escalate into a process-killing uncaught exception.
  try {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname === "/api/ws") {
      handleChatUpgrade(req, socket, head);
    } else if (url.pathname === "/api/ws/radio") {
      handleRadioUpgrade(req, socket, head);
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  } catch (err) {
    logger.warn({ err }, "WS upgrade dispatch failed");
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

// Load super-admin brand + feature-flag overrides into memory so emails, PDFs,
// the requireFeature() middleware and GET /api/brand reflect DB state from the
// first request. server.listen (above) already opened the port, so this stays
// non-blocking; GET /api/brand awaits this same readiness signal before its
// first response so a redeploy never briefly serves the env-baseline company
// name or feature set. Falls back to env defaults after a short timeout (or if
// the tables don't exist yet, pre-`db push`).
initConfigReadiness();


loadConfirmEditWindowConfigFromDb()
  .then(() => logger.info("Confirm edit-window config loaded"))
  .catch((err) => logger.error({ err }, "Failed to load confirm edit-window config"));

seedPolicies()
  .then(() => logger.info("Default policies ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed default policies"));

// One-time backfill of applicant + onboarding fields onto employees rows.
// Idempotent (COALESCE-only): safe to run on every boot.
const employeeProfileBackfillDone = backfillEmployeeProfileFields()
  .then(() => logger.info("Employee profile backfill complete"))
  .catch((err) => logger.error({ err }, "Failed to backfill employee profile fields"));

// Ensure active admin accounts are never stuck behind a forced-password-
// change screen — clears mustChangePassword for all active admins on boot
// so both dev and production stay consistent.
ensureAdminAccountHealth()
  .then(() => logger.info("Admin account health ensured"))
  .catch((err) => logger.error({ err }, "Failed to ensure admin account health"));

// One-time idempotent role migration: the legacy "lead" role was renamed to
// "site_manager". Flip any historical rows so existing supervisors keep access
// under the new role key. Once migrated this selects 0 rows and no-ops.
migrateLeadRoleToSiteManager()
  .then(() => logger.info("Legacy lead role migrated to site_manager"))
  .catch((err) => logger.error({ err }, "Failed to migrate lead role to site_manager"));

// Idempotently provision the documented demo accounts so `replit.md`
// credentials always work. Disable with SEED_DEMO_USERS=false.
const demoUsersSeeded = seedDemoUsers()
  .then(() => logger.info("Demo users ensured"))
  .catch((err) => logger.error({ err }, "Failed to seed demo users"));

// Backfill missing employees rows for every user (admin OR employee) so
// Users / Personnel / Employees stay aligned. Idempotent — only inserts
// rows the LEFT JOIN flags as missing.
const employeesRowsBackfilled = ensureEmployeesRowsForAllUsers()
  .then(() => logger.info("Employees rows backfilled for all users"))
  .catch((err) => logger.error({ err }, "Failed to backfill employees rows"));

// One-time idempotent backfill: flag existing non-admin staff who have never
// signed company policies so the mobile login gate (users.mustSignPolicies)
// catches them once. MUST run only after (a) every officer has an employees
// row, (b) onboarding acknowledgements have been copied onto that row, and
// (c) demo accounts are seeded — otherwise a legacy already-signed officer
// whose acks haven't landed yet gets falsely flagged, or a freshly-seeded
// non-admin slips past the gate. Never targets admins; safe on every boot.
Promise.all([employeeProfileBackfillDone, employeesRowsBackfilled, demoUsersSeeded])
  .then(() => backfillMustSignPolicies())
  .then(() => logger.info("Must-sign-policies flag backfilled for unsigned staff"))
  .catch((err) => logger.error({ err }, "Failed to backfill must-sign-policies flag"));

// One-time idempotent backfill: for draft invoices created before the
// per-site processing fee unification (where taxAmount held the site fee
// and processingFeeAmount was NULL), move tax_amount → processing_fee_amount
// and zero tax_amount. Only touches draft rows with tax_amount > 0 and
// processing_fee_amount IS NULL; finalized invoices are never modified.
// The function always logs a structured summary (checked/repaired/skipped)
// so operators can confirm the migration ran cleanly after every deploy.
import("./lib/invoiceProcessingFeeBackfill")
  .then((m) => m.backfillInvoiceProcessingFees())
  .catch((err) => logger.error({ err }, "Failed to backfill invoice processing fees"));

// One-time idempotent repair: copy employees.phone -> users.phoneNumber for
// historical rows so officers are SMS-reachable and their number shows on the
// user profile. Forward-sync keeps both columns aligned after this; once
// repaired, this selects 0 rows and no-ops.
backfillUserPhoneNumbersFromEmployees()
  .then(() => logger.info("User phone numbers backfilled from employee files"))
  .catch((err) => logger.error({ err }, "Failed to backfill user phone numbers"));

// One-time idempotent repair: the platform_brand_config billing_email was
// stored as admin@williamscouncilsecurity.com (an old incorrect value). Flip
// it to pay@williamscouncil.com so invoice PDF footers use the right address.
// Safe to run on every boot — only fires when the stale value is still present.
backfillBillingEmail()
  .then(() => logger.info("Billing email backfill complete"))
  .catch((err) => logger.error({ err }, "Failed to backfill billing email"));

// One-time idempotent repair (production only): re-provision applicants who
// were APPROVED but whose login account + onboarding token were later deleted
// out from under the still-"approved" application (e.g. by deleting the user
// row directly from the admin Users table before that path un-stranded the
// application). Such people are invisible in Onboarding and cannot log in.
// This mints a fresh pending account + token and re-sends the onboarding email
// + SMS so they get a working link and temporary password. Gated to production
// because (a) dev/test share no data with prod and (b) SMS is NOT
// environment-suppressed, so it would fire live texts from a dev boot. Set
// DISABLE_ONBOARDING_RESTORE=true to publish without re-inviting anyone.
if (process.env.NODE_ENV === "production" && process.env.DISABLE_ONBOARDING_RESTORE !== "true") {
  restoreStrandedOnboardingApplicants()
    .then((r) => logger.info(r, "Stranded onboarding applicants restore finished"))
    .catch((err) => logger.error({ err }, "Failed to restore stranded onboarding applicants"));
}

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

// ── Graceful shutdown ──────────────────────────────────────────────────────
// The deployment platform sends SIGTERM before starting the replacement
// process. Without this handler, Node exits instantly — the OS port enters
// TIME_WAIT for a few seconds, the new process hits EADDRINUSE, and crashes.
// The correct sequence: stop accepting → drain open connections → close WS
// servers → release the DB pool → exit 0. A 10-second hard-kill guards
// against connections that never drain (e.g. long-lived WebSockets that
// missed the close frame).
function gracefulShutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal — draining connections");

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out after 10 s — forcing exit");
    process.exit(1);
  }, 10_000);
  // Don't let the timer keep the process alive past the normal exit.
  forceExit.unref();

  // 1. Stop accepting new HTTP/WS connections.
  server.close(() => {
    logger.info("HTTP server closed");

    // 3. Release the database connection pool.
    pool.end().then(() => {
      logger.info("Database pool closed — exiting cleanly");
      clearTimeout(forceExit);
      process.exit(0);
    }).catch((err) => {
      logger.error({ err }, "Error closing database pool");
      clearTimeout(forceExit);
      process.exit(1);
    });
  });

  // 2. Close WebSocket servers — this terminates all open sockets so
  //    server.close() above doesn't wait forever for them to drain.
  const chatWss = getWss();
  if (chatWss) {
    chatWss.clients.forEach((ws) => ws.terminate());
    chatWss.close();
  }
  const radioWss = getRadioWss();
  if (radioWss) {
    radioWss.clients.forEach((ws) => ws.terminate());
    radioWss.close();
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// ── Last-resort safety nets ────────────────────────────────────────────────
// Without these, a single stray async error anywhere (a rejected promise no
// one awaited, an EventEmitter 'error' with no listener) crashes the whole
// process and takes the service down. We log loudly so the bug is still
// visible, but we do NOT tear the server down for a recoverable rejection —
// keeping the deployment up is the priority.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection — keeping process alive");
});

// An uncaughtException leaves the process in an unknown state, so the safe
// move is to drain and let the platform start a fresh instance.
let shuttingDownFromCrash = false;
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — draining and restarting");
  if (shuttingDownFromCrash) return;
  shuttingDownFromCrash = true;
  gracefulShutdown("uncaughtException");
});
