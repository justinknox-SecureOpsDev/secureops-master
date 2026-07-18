/**
 * Fleet health poller.
 *
 * Periodically polls every active customer's public GET /api/version and records
 * status / latency / reported build version back into the registry. The operator
 * dashboard reads these columns to show online/offline + "needs update".
 */

import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./config";
import { pool, type CustomerRow } from "./db";
import { logger } from "./logger";

export interface ProbeResult {
  status: "online" | "offline";
  latency: number | null;
  version: string | null;
  builtAt: string | null;
  lastError: string | null;
  seen: boolean;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe a single customer backend (no DB writes — pure, unit-testable).
 *
 * Primary probe is the modern `/api/version` endpoint (build identity). Older
 * customer templates predate it and return 404 there; rather than reporting
 * them as offline, we fall back to `/api/healthz` — a reachable healthz means
 * "online, version unknown (not yet remotely manageable)", which the dashboard
 * renders as online with a blank version. Network failures stay offline.
 */
export async function probeBackend(apiBaseUrl: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const verRes = await fetchWithTimeout(`${apiBaseUrl}/api/version`);
    if (verRes.ok) {
      const body = (await verRes.json().catch(() => ({}))) as {
        version?: string;
        builtAt?: string;
      };
      return {
        status: "online",
        latency: Date.now() - started,
        version: typeof body.version === "string" ? body.version : null,
        builtAt: typeof body.builtAt === "string" ? body.builtAt : null,
        lastError: null,
        seen: true,
      };
    }
    if (verRes.status === 404) {
      // Legacy backend without /api/version — degrade gracefully via healthz.
      const healthRes = await fetchWithTimeout(`${apiBaseUrl}/api/healthz`);
      if (healthRes.ok) {
        return {
          status: "online",
          latency: Date.now() - started,
          version: null,
          builtAt: null,
          lastError: "No /api/version (legacy backend) — version unknown",
          seen: true,
        };
      }
      return {
        status: "offline",
        latency: Date.now() - started,
        version: null,
        builtAt: null,
        lastError: `HTTP ${healthRes.status}`,
        seen: false,
      };
    }
    return {
      status: "offline",
      latency: Date.now() - started,
      version: null,
      builtAt: null,
      lastError: `HTTP ${verRes.status}`,
      seen: false,
    };
  } catch (err) {
    return {
      status: "offline",
      latency: Date.now() - started,
      version: null,
      builtAt: null,
      lastError: err instanceof Error ? err.message : String(err),
      seen: false,
    };
  }
}

async function pollOne(row: Pick<CustomerRow, "id" | "api_base_url">): Promise<void> {
  const { status, latency, version, builtAt, lastError, seen } = await probeBackend(
    row.api_base_url,
  );

  await pool.query(
    `UPDATE control_plane_customers
       SET last_status = $2,
           last_latency_ms = $3,
           last_error = $4,
           reported_version = COALESCE($5, reported_version),
           reported_built_at = COALESCE($6, reported_built_at),
           last_seen_at = CASE WHEN $7 THEN now() ELSE last_seen_at END,
           updated_at = now()
     WHERE id = $1`,
    [row.id, status, latency, lastError, version, builtAt, seen],
  );
}

export async function pollAllOnce(): Promise<void> {
  const { rows } = await pool.query<Pick<CustomerRow, "id" | "api_base_url">>(
    `SELECT id, api_base_url FROM control_plane_customers WHERE is_active = TRUE`,
  );
  await Promise.allSettled(rows.map((r) => pollOne(r)));
}

export function startPoller(): void {
  const run = () => {
    pollAllOnce().catch((err) => logger.error({ err: String(err) }, "[poller] cycle failed"));
  };
  // First run shortly after boot, then on the interval.
  setTimeout(run, 3000);
  setInterval(run, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "[poller] started");
}
