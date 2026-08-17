/**
 * Control-plane database.
 *
 * The registry lives in the control plane's OWN Postgres (CONTROL_PLANE_DATABASE_URL),
 * falling back to DATABASE_URL only for local dev convenience. The schema is
 * created idempotently on boot with CREATE TABLE IF NOT EXISTS — it is delib-
 * erately kept OUT of @workspace/db so the customer backend's schema-drift gate
 * never sees these operator-only tables.
 */

import { randomUUID } from "node:crypto";
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

  // Trial→Paid lifecycle tracking. New customers default to 'trial'; flipping
  // to 'paid' (via the update API) stamps converted_at. Historical rows with
  // no explicit conversion keep converted_at NULL even if manually set to paid.
  await pool.query(
    `ALTER TABLE control_plane_customers ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'trial';`,
  );
  await pool.query(
    `ALTER TABLE control_plane_customers ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;`,
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

/**
 * Seed the registry with customers that must exist on every deployment of
 * THIS control plane, so their presence doesn't depend on someone remembering
 * to click "Add customer" by hand. Idempotent (ON CONFLICT DO NOTHING keyed
 * on the unique org_code) — safe to call on every boot.
 *
 * Quell Protection ("quell") is a prospective customer whose trial-to-paid
 * onboarding is being tracked here ahead of their backend fork existing. The
 * placeholder `.invalid` backend URL (RFC 2606 reserved TLD — guaranteed to
 * never resolve) must be replaced with their real fork/deployment address
 * once it exists; see docs/new-customer-setup-runbook.md.
 */
export async function seedInitialCustomers(): Promise<void> {
  await pool.query(
    `INSERT INTO control_plane_customers (id, org_code, name, api_base_url, notes, is_active)
     VALUES ($1, 'quell', 'Quell Protection', $2, $3, FALSE)
     ON CONFLICT (org_code) DO NOTHING;`,
    [
      randomUUID(),
      "https://quell-protection.placeholder.invalid",
      "PLACEHOLDER backend URL — fork not yet created. Replace api_base_url with the real fork/deployment address once the Replit fork exists and a custom domain (or .replit.app URL) is known. See docs/new-customer-setup-runbook.md.",
    ],
  );
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
  lifecycle_status: string;
  converted_at: Date | null;
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
