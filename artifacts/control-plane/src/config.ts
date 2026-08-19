/**
 * Control-plane configuration.
 *
 * This is an OPERATOR-ONLY deployment, separate from any customer backend. It
 * has its own database, its own session secret, and its own encryption key.
 *
 * In production every secret MUST be provided via env — boot fails fast if a
 * required one is missing. In development we fall back to clearly-labelled,
 * non-secret defaults so the app is runnable locally without provisioning.
 */

export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_PROD = NODE_ENV === "production";

export const PORT = Number.parseInt(process.env.PORT ?? "9999", 10);

/**
 * The master API build this control-plane deployment was shipped alongside.
 * `build.mjs` injects the Git SHA (or explicit BUILD_VERSION) at build time,
 * matching the identity returned by a current customer `/api/version`.
 */
declare const __MASTER_BUILD_VERSION__: string;
export const MASTER_BUILD_VERSION =
  (typeof __MASTER_BUILD_VERSION__ !== "undefined" && __MASTER_BUILD_VERSION__) ||
  process.env.BUILD_VERSION ||
  "unknown";

/** Own registry DB; falls back to the shared DATABASE_URL for local dev. */
export const DATABASE_URL =
  process.env.CONTROL_PLANE_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";

const DEV_SESSION_SECRET = "dev-control-plane-session-secret-change-me";
const DEV_ENCRYPTION_KEY = "dev-control-plane-encryption-key-change-me";
const DEV_OPERATOR_EMAIL = "operator@control-plane.local";
const DEV_OPERATOR_PASSWORD = "operator";

function requiredInProd(name: string, value: string | undefined, devFallback: string): string {
  const v = (value ?? "").trim();
  if (v.length > 0) return v;
  if (IS_PROD) {
    throw new Error(`[control-plane] ${name} is required in production but is not set.`);
  }
  return devFallback;
}

export const SESSION_SECRET = requiredInProd(
  "CONTROL_PLANE_SESSION_SECRET",
  process.env.CONTROL_PLANE_SESSION_SECRET,
  DEV_SESSION_SECRET,
);

export const ENCRYPTION_KEY = requiredInProd(
  "CONTROL_PLANE_ENCRYPTION_KEY",
  process.env.CONTROL_PLANE_ENCRYPTION_KEY,
  DEV_ENCRYPTION_KEY,
);

export const OPERATOR_EMAIL = requiredInProd(
  "CONTROL_PLANE_OPERATOR_EMAIL",
  process.env.CONTROL_PLANE_OPERATOR_EMAIL,
  DEV_OPERATOR_EMAIL,
).toLowerCase();

/** Either a bcrypt hash (preferred) or a plaintext password. */
export const OPERATOR_PASSWORD_HASH = (process.env.CONTROL_PLANE_OPERATOR_PASSWORD_HASH ?? "").trim();
// In prod we accept EITHER a bcrypt hash OR a plaintext password. When a hash is
// supplied the plaintext password is optional (it's never consulted — see
// verifyOperatorCredentials), so don't hard-fail boot for a missing plaintext.
// Only require the plaintext password in prod when no hash is configured.
export const OPERATOR_PASSWORD =
  OPERATOR_PASSWORD_HASH.length > 0
    ? (process.env.CONTROL_PLANE_OPERATOR_PASSWORD ?? "").trim()
    : requiredInProd(
        "CONTROL_PLANE_OPERATOR_PASSWORD",
        process.env.CONTROL_PLANE_OPERATOR_PASSWORD,
        DEV_OPERATOR_PASSWORD,
      );

/** Browser origins allowed to call the operator API (the console is same-origin). */
export const ALLOWED_ORIGINS: string[] = [
  ...(process.env.CONTROL_PLANE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...(process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((d) => (d.startsWith("http") ? d : `https://${d}`)),
];

/** How often the health poller refreshes customer status/version (ms). */
export const POLL_INTERVAL_MS = Number.parseInt(
  process.env.CONTROL_PLANE_POLL_INTERVAL_MS ?? "60000",
  10,
);

/** Per-request timeout when polling a customer backend (ms). */
export const POLL_TIMEOUT_MS = Number.parseInt(
  process.env.CONTROL_PLANE_POLL_TIMEOUT_MS ?? "8000",
  10,
);

/**
 * Retention window for the remote-change audit trail, in days. Rows older than
 * this are pruned by a periodic job so `control_plane_remote_changes` does not
 * grow unbounded over the life of a fleet. `0` (or negative) disables pruning.
 */
export const REMOTE_CHANGE_RETENTION_DAYS = Number.parseInt(
  process.env.CONTROL_PLANE_REMOTE_CHANGE_RETENTION_DAYS ?? "180",
  10,
);

/** How often the retention job runs (ms). Defaults to once every 24h. */
export const RETENTION_INTERVAL_MS = Number.parseInt(
  process.env.CONTROL_PLANE_RETENTION_INTERVAL_MS ?? String(24 * 60 * 60 * 1000),
  10,
);

export const JWT_TTL_SECONDS = 60 * 60 * 12; // 12h operator sessions
