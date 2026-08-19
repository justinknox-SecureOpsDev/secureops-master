/**
 * Fleet health poller.
 *
 * Periodically polls every active customer's public GET /api/version and records
 * status / latency / reported build version back into the registry. The operator
 * dashboard reads these columns to show online/offline + "needs update".
 */

import { MASTER_BUILD_VERSION, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "./config";
import { pool, type CustomerRow } from "./db";
import { decryptSecret } from "./crypto";
import { callCustomerControlPlane } from "./hmacClient";
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

/**
 * Fetch the tenant's agreement signed-status via the HMAC-gated management
 * surface. Returns the JSON string to store, or `undefined` to keep whatever
 * snapshot we already have (backend unreachable / transient error), or `null`
 * to clear it (no secret configured — status unknowable).
 */
export async function fetchAgreementsSnapshot(
  apiBaseUrl: string,
  secret: string | null,
): Promise<string | null | undefined> {
  if (!secret) return null;
  try {
    const result = await callCustomerControlPlane(
      apiBaseUrl,
      "/api/control-plane/agreements",
      "GET",
      secret,
    );
    if (result.ok && result.body && typeof result.body === "object") {
      const agreements = (result.body as { agreements?: unknown }).agreements;
      if (agreements && typeof agreements === "object") {
        return JSON.stringify({ fetchedAt: new Date().toISOString(), slots: agreements });
      }
    }
    if (result.status === 404) {
      // Legacy backend without the agreements surface — status unknowable.
      return null;
    }
    return undefined; // 401/503/5xx etc — keep the last known snapshot
  } catch {
    return undefined; // network failure — keep the last known snapshot
  }
}

/**
 * Fetch the tenant's commercial config (plan tier + monthly price etc) via the
 * HMAC-gated management surface. Returns the JSON string to store, or `undefined`
 * to keep whatever snapshot we already have (backend unreachable / transient
 * error), or `null` to clear it (no secret configured, or a legacy backend that
 * predates the surface — plan unknowable).
 *
 * We snapshot the WHOLE `customerConfig` object (not just tier/price) so the
 * fleet overview can grow without another schema/poller change; a missing
 * `customerConfig` (backend reachable but no config saved) still stores a
 * snapshot with `config: null` so the UI shows "not set" rather than staling.
 */
export async function fetchCustomerConfigSnapshot(
  apiBaseUrl: string,
  secret: string | null,
): Promise<string | null | undefined> {
  if (!secret) return null;
  try {
    const result = await callCustomerControlPlane(
      apiBaseUrl,
      "/api/control-plane/settings",
      "GET",
      secret,
    );
    if (result.ok && result.body && typeof result.body === "object") {
      const config = (result.body as { customerConfig?: unknown }).customerConfig ?? null;
      return JSON.stringify({ fetchedAt: new Date().toISOString(), config });
    }
    if (result.status === 404) {
      // Legacy backend without the settings surface — plan unknowable.
      return null;
    }
    return undefined; // 401/503/5xx etc — keep the last known snapshot
  } catch {
    return undefined; // network failure — keep the last known snapshot
  }
}

type PollRow = Pick<CustomerRow, "id" | "api_base_url" | "mgmt_secret_enc">;

export async function pollCustomer(
  row: PollRow,
  masterVersion: string | null,
): Promise<void> {
  const { status, latency, version, builtAt, lastError, seen } = await probeBackend(
    row.api_base_url,
  );

  let secret: string | null = null;
  if (row.mgmt_secret_enc) {
    try {
      secret = decryptSecret(row.mgmt_secret_enc);
    } catch (err) {
      logger.error({ err: String(err), id: row.id }, "[poller] secret decrypt failed");
    }
  }
  const agreements = seen ? await fetchAgreementsSnapshot(row.api_base_url, secret) : undefined;
  const customerConfig = seen
    ? await fetchCustomerConfigSnapshot(row.api_base_url, secret)
    : undefined;

  await pool.query(
    `UPDATE control_plane_customers
       SET last_status = $2,
           last_latency_ms = $3,
           last_error = $4,
            reported_version = CASE WHEN $7 THEN $5 ELSE reported_version END,
            reported_built_at = CASE WHEN $7 THEN $6 ELSE reported_built_at END,
           last_seen_at = CASE WHEN $7 THEN now() ELSE last_seen_at END,
            last_current_at = CASE
              WHEN $5 IS NOT NULL AND $5 = $8 THEN now()
              ELSE last_current_at
            END,
            agreements_json = CASE WHEN $9 THEN $10 ELSE agreements_json END,
            customer_config_json = CASE WHEN $11 THEN $12 ELSE customer_config_json END,
           updated_at = now()
     WHERE id = $1`,
    [
      row.id,
      status,
      latency,
      lastError,
      version,
      builtAt,
      seen,
      masterVersion,
      agreements !== undefined,
      agreements ?? null,
      customerConfig !== undefined,
      customerConfig ?? null,
    ],
  );
}

export async function pollAllOnce(): Promise<void> {
  // The reference is recorded in the registry automatically with every poll.
  // Do not replace a known reference with "unknown" in source archives where
  // Git metadata was unavailable at build time.
  const masterVersion = MASTER_BUILD_VERSION !== "unknown" ? MASTER_BUILD_VERSION : null;
  if (masterVersion) {
    await pool.query(
      `UPDATE control_plane_settings
       SET master_recorded_at = CASE
             WHEN master_version IS DISTINCT FROM $1 THEN now()
             ELSE master_recorded_at
           END,
           master_version = $1,
           updated_at = now()
       WHERE id = 'singleton'`,
      [masterVersion],
    );
  }
  const { rows } = await pool.query<PollRow>(
    `SELECT id, api_base_url, mgmt_secret_enc FROM control_plane_customers WHERE is_active = TRUE`,
  );
  await Promise.allSettled(rows.map((r) => pollCustomer(r, masterVersion)));
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
