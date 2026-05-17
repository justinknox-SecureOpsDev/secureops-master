import type { Request, Response, NextFunction } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Audit log middleware.
 *
 * Records every successful write (POST/PUT/PATCH/DELETE 2xx response)
 * on a configurable allow-list of paths. The middleware:
 *   - Captures actor identity from `req.user` (so it must run AFTER
 *     `requireAuth` / `requireAdmin`).
 *   - Defers DB write until `res.on("finish")` so we know the final
 *     status code and never block the response.
 *   - Truncates request bodies to a safe size and redacts well-known
 *     sensitive keys (passwords, SSN, bank acct numbers, JWT) before
 *     persisting — we want change tracking, not a giant secret leak.
 *   - On `/admin/tables/:table[/:id]`, parses the path so the audit
 *     row carries `targetTable` + `targetId` for grid-style filtering.
 *
 * The middleware itself never throws — failures are logged and
 * swallowed so an audit-log outage never breaks user-facing writes.
 */

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "currentpassword",
  "newpassword",
  "temppassword",
  "temppasswordplain",
  "bankaccountnumber",
  "ninumber",
  "ssn",
  "ssnlast4",
  "token",
  "jwt",
  "authorization",
  "auth_token",
  "secret",
]);

const MAX_JSON_BYTES = 8 * 1024; // 8KB cap on persisted request body

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return value.slice(0, 2000) + "…[truncated]";
  return value;
}

function safeJson(value: unknown): unknown {
  try {
    const redacted = redact(value);
    const s = JSON.stringify(redacted);
    if (s.length > MAX_JSON_BYTES) {
      return { _truncated: true, preview: s.slice(0, MAX_JSON_BYTES) };
    }
    return redacted;
  } catch {
    return null;
  }
}

// Map URL prefixes to a friendly action label. The first match wins.
// Order matters — list more-specific paths first.
const ACTION_RULES: Array<{ prefix: string; action: string }> = [
  { prefix: "/payroll/pay-run/export-csv", action: "payroll.export_csv" },
  { prefix: "/payroll/pay-run/mark-paid", action: "payroll.mark_paid" },
  { prefix: "/payroll/pay-run/preview", action: "payroll.preview" },
  { prefix: "/payroll/pay-run/stripe", action: "payroll.stripe" },
  { prefix: "/payroll", action: "payroll.update" },
  { prefix: "/admin/applications", action: "application.review" },
  { prefix: "/admin/users/bulk-temp-passwords", action: "users.bulk_temp_passwords" },
  { prefix: "/admin/users/bulk-invite", action: "users.bulk_invite" },
  { prefix: "/admin/users", action: "users.admin_change" },
  { prefix: "/admin/import/", action: "table.import" },
  { prefix: "/admin/tables/", action: "table.write" },
  { prefix: "/admin/exports/preview", action: "exports.preview" },
  { prefix: "/admin/exports/csv", action: "exports.csv" },
  { prefix: "/admin/exports/pdf", action: "exports.pdf" },
  { prefix: "/admin/radio/channels", action: "radio.channels_admin" },
  { prefix: "/admin", action: "admin.action" },
  { prefix: "/shifts/repeat", action: "shifts.repeat_create" },
  { prefix: "/shifts", action: "shifts.write" },
  { prefix: "/clients", action: "clients.write" },
  { prefix: "/sites", action: "sites.write" },
  { prefix: "/invoices", action: "invoices.write" },
  { prefix: "/incidents", action: "incidents.write" },
  { prefix: "/time-entries", action: "time_entries.write" },
];

function classifyAction(path: string): string | null {
  for (const { prefix, action } of ACTION_RULES) {
    if (path.startsWith(prefix)) return action;
  }
  return null;
}

// Extract `{table, id}` from /admin/tables/:table[/:id] so the audit row
// can be filtered by table + record. Returns nulls for non-matching paths.
function parseAdminTablesPath(path: string): { table: string | null; id: string | null } {
  const m = path.match(/^\/admin\/tables\/([^\/?]+)(?:\/([^\/?]+))?/);
  if (!m) return { table: null, id: null };
  return { table: m[1] ?? null, id: m[2] ?? null };
}

/** Express middleware. Place after `requireAdmin` / `requireAuth`. */
export function auditLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (!writeMethods.has(req.method)) {
    next();
    return;
  }

  // Snapshot the request body now (before the handler mutates it) +
  // route metadata. Actor identity is read INSIDE the finish handler
  // because this middleware runs before requireAuth — at this point
  // `req.user` is still undefined for every request.
  const pathOnly = (req.originalUrl || req.url || "").split("?")[0]!;
  // The router strips the /api prefix before middleware runs, but
  // originalUrl preserves it. Normalize to the router-relative path
  // for action classification.
  const routerPath = pathOnly.startsWith("/api") ? pathOnly.slice(4) : pathOnly;
  const action = classifyAction(routerPath);
  // Only audit privileged paths. Public/auth routes (login, application
  // submission, password reset) are noisy and already covered by their
  // own rate limiters and request logs.
  if (action === null) {
    next();
    return;
  }
  const { table, id } = parseAdminTablesPath(routerPath);
  const bodySnapshot = safeJson(req.body);
  const ip = req.ip ?? null;
  const userAgent = req.headers["user-agent"] ?? null;

  res.on("finish", () => {
    // Only log successful writes — 4xx/5xx are noise here and would
    // double-count rate-limit/validation failures we already log.
    if (res.statusCode >= 400) return;

    // Read actor AFTER the response finishes — by then requireAuth /
    // requireAdmin have populated req.user on every privileged route.
    // Anonymous-but-2xx hits on a privileged path (shouldn't happen
    // post-auth, but defensive) are still recorded so we can spot the
    // misconfiguration.
    const actorUserId = req.user?.userId ?? null;
    const actorEmail = req.user?.email ?? null;
    const actorRole = req.user?.role ?? null;

    // Fire-and-forget; never block the response. Errors are logged at
    // warn level so a DB blip is visible without page failure.
    void (async () => {
      try {
        await db.insert(auditLogsTable).values({
          actorUserId,
          actorEmail,
          actorRole,
          action,
          targetTable: table,
          targetId: id,
          method: req.method,
          path: routerPath,
          statusCode: res.statusCode,
          ip,
          userAgent: typeof userAgent === "string" ? userAgent.slice(0, 500) : null,
          before: null,
          after: bodySnapshot ?? null,
          metadata: (res.locals?.["auditMetadata"] as Record<string, unknown> | undefined) ?? null,
        });
      } catch (err) {
        logger.warn({ err, path: routerPath, method: req.method }, "[audit] failed to persist log entry");
      }
    })();
  });

  next();
}
