/**
 * Control-plane database.
 *
 * The registry lives in the control plane's OWN Postgres (CONTROL_PLANE_DATABASE_URL),
 * falling back to DATABASE_URL only for local dev convenience. The schema is
 * created idempotently on boot with CREATE TABLE IF NOT EXISTS — it is delib-
 * erately kept OUT of @workspace/db so the customer backend's schema-drift gate
 * never sees these operator-only tables.
 */

import pg from "pg";
import { DATABASE_URL } from "./config";
import { logger } from "./logger";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
});

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_plane_customers (
      id               TEXT PRIMARY KEY,
      org_code         TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      api_base_url     TEXT NOT NULL,
      contact_name     TEXT,
      contact_email    TEXT,
      notes            TEXT,
      mgmt_secret_enc  TEXT,
      target_version   TEXT,
      reported_version TEXT,
      reported_built_at TEXT,
      last_status      TEXT NOT NULL DEFAULT 'unknown',
      last_latency_ms  INTEGER,
      last_seen_at     TIMESTAMPTZ,
      last_error       TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_plane_settings (
      id             TEXT PRIMARY KEY DEFAULT 'singleton',
      target_version TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    INSERT INTO control_plane_settings (id) VALUES ('singleton')
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_cp_customers_org_code ON control_plane_customers (org_code);`,
  );

  // Per-tenant agreement signed-status snapshot (JSON), refreshed by the poller
  // via the HMAC-gated /api/control-plane/agreements surface.
  await pool.query(
    `ALTER TABLE control_plane_customers ADD COLUMN IF NOT EXISTS agreements_json TEXT;`,
  );

  // Per-tenant commercial-config snapshot (JSON: plan tier + monthly price etc),
  // refreshed by the poller via the HMAC-gated /api/control-plane/settings surface.
  // Drives the fleet-wide plan/MRR overview so an operator sees who's on which
  // plan without opening each customer's Remote Settings modal.
  await pool.query(
    `ALTER TABLE control_plane_customers ADD COLUMN IF NOT EXISTS customer_config_json TEXT;`,
  );

  // Audit trail of remote brand/feature changes pushed to customer backends.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_plane_remote_changes (
      id          TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES control_plane_customers(id) ON DELETE CASCADE,
      operator    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      status      INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_cp_remote_changes_customer
       ON control_plane_remote_changes (customer_id, created_at DESC);`,
  );

  logger.info("[control-plane] schema ensured");
}

export interface CustomerRow {
  id: string;
  org_code: string;
  name: string;
  api_base_url: string;
  contact_name: string | null;
  contact_email: string | null;
  notes: string | null;
  mgmt_secret_enc: string | null;
  agreements_json: string | null;
  customer_config_json: string | null;
  target_version: string | null;
  reported_version: string | null;
  reported_built_at: string | null;
  last_status: string;
  last_latency_ms: number | null;
  last_seen_at: Date | null;
  last_error: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RemoteChangeRow {
  id: string;
  customer_id: string;
  operator: string;
  kind: string;
  summary: string;
  status: number | null;
  created_at: Date;
}
