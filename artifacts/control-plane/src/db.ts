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
import type { PoolClient } from "pg";
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
      master_version TEXT,
      master_recorded_at TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    INSERT INTO control_plane_settings (id) VALUES ('singleton')
    ON CONFLICT (id) DO NOTHING;
  `);
  // Existing control-plane databases already have this table, so add the
  // automatic reference fields independently of CREATE TABLE above.
  await pool.query(
    `ALTER TABLE control_plane_settings ADD COLUMN IF NOT EXISTS master_version TEXT;`,
  );
  await pool.query(
    `ALTER TABLE control_plane_settings ADD COLUMN IF NOT EXISTS master_recorded_at TIMESTAMPTZ;`,
  );

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

  // Last time this tenant reported the current master build. It is deliberately
  // retained while the tenant is behind/offline, giving operators a useful
  // "last known current" timestamp instead of merely the latest probe time.
  await pool.query(
    `ALTER TABLE control_plane_customers ADD COLUMN IF NOT EXISTS last_current_at TIMESTAMPTZ;`,
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

  // Per-customer onboarding checklist. One row per runbook phase/step; seeded
  // automatically when a new customer is registered. Operators tick steps off
  // manually as they work through the runbook — no automated verification.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_plane_onboarding_checklist (
      id          TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES control_plane_customers(id) ON DELETE CASCADE,
      step_key    TEXT NOT NULL,
      step_label  TEXT NOT NULL,
      step_order  INTEGER NOT NULL,
      is_done     BOOLEAN NOT NULL DEFAULT FALSE,
      done_at     TIMESTAMPTZ,
      UNIQUE (customer_id, step_key)
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_cp_checklist_customer
       ON control_plane_onboarding_checklist (customer_id, step_order ASC);`,
  );

  // Checklist archive: preserves done-step state keyed by org_code so that
  // if a customer record is deleted and re-added with the same org code, the
  // operator's progress is restored automatically rather than starting fresh.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_plane_checklist_archive (
      org_code    TEXT NOT NULL,
      step_key    TEXT NOT NULL,
      done_at     TIMESTAMPTZ,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_code, step_key)
    );
  `);

  logger.info("[control-plane] schema ensured");
}

/** The ordered runbook phases that make up the onboarding checklist. */
export const ONBOARDING_STEPS: ReadonlyArray<{ key: string; label: string; order: number }> = [
  { key: "phase1_fork", label: "Phase 1 — Fork the template", order: 1 },
  { key: "phase2_clean_env", label: "Phase 2 — Clean the env copy (env vars, org code, dev DB)", order: 2 },
  { key: "phase3_secrets", label: "Phase 3 — Secrets & integrations configured", order: 3 },
  { key: "phase4_publish", label: "Phase 4 — First publish verified (Reserved VM)", order: 4 },
  { key: "phase5_brand", label: "Phase 5 — Branded in-app (name, colors, logo)", order: 5 },
  { key: "phase6_domain", label: "Phase 6 — Custom domain configured", order: 6 },
  {
    key: "phase7_org_directory",
    label: "Phase 7 — Org code registered in master directory & master republished",
    order: 7,
  },
  {
    key: "phase8_fleet_console",
    label: "Phase 8 — Registered in fleet console with management secret",
    order: 8,
  },
  { key: "phase9_acceptance", label: "Phase 9 — Acceptance checklist passed", order: 9 },
  {
    key: "phase10_handover",
    label: "Phase 10 — Handed over & locked down (demo users deactivated)",
    order: 10,
  },
  { key: "phase11_paid", label: "Phase 11 — Trial → Paid (signed & payment started)", order: 11 },
];

/**
 * Snapshot the current checklist state for a customer into the archive, keyed
 * by org_code. Called inside the DELETE transaction so the snapshot is written
 * before the customer row (and its CASCADE-deleted checklist) disappears.
 *
 * This is a FULL SNAPSHOT, not an accumulation: we delete ALL existing archive
 * rows for this org_code first, then re-insert only the currently-done steps.
 * This means that if a step was done on a previous record, then explicitly
 * un-done on the current record before deletion, it will NOT be restored on
 * re-creation (the archive reflects the last known state, not max-ever state).
 */
export async function archiveChecklistForCustomer(
  customerId: string,
  orgCode: string,
  client: PoolClient,
): Promise<void> {
  // Clear the old snapshot for this org code first so un-done steps don't linger.
  await client.query(
    `DELETE FROM control_plane_checklist_archive WHERE org_code = $1`,
    [orgCode],
  );
  // Insert the current done steps as the new snapshot.
  await client.query(
    `INSERT INTO control_plane_checklist_archive (org_code, step_key, done_at, archived_at)
     SELECT $2, step_key, done_at, now()
     FROM control_plane_onboarding_checklist
     WHERE customer_id = $1 AND is_done = true`,
    [customerId, orgCode],
  );
}

/**
 * After seeding checklist rows for a newly created customer, restore any done
 * steps that were archived for that org_code (from a previous customer record
 * with the same org code that was deleted). Only steps that exist in both the
 * current checklist AND the archive are restored — steps removed from
 * ONBOARDING_STEPS are ignored.
 */
export async function restoreChecklistFromArchive(
  customerId: string,
  orgCode: string,
  client: PoolClient,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE control_plane_onboarding_checklist cl
     SET is_done = true, done_at = a.done_at
     FROM control_plane_checklist_archive a
     WHERE cl.customer_id = $1
       AND cl.step_key = a.step_key
       AND a.org_code = $2`,
    [customerId, orgCode],
  );
  return rowCount ?? 0;
}

/**
 * Seed the default onboarding checklist rows for a newly created customer.
 * Idempotent (ON CONFLICT DO NOTHING on the (customer_id, step_key) unique
 * constraint) — safe to call multiple times without creating duplicates.
 *
 * Pass a `client` to run this inside an existing transaction (e.g. the same
 * transaction as the customer INSERT so creation and seeding are atomic).
 * When `client` is omitted the pool default is used (safe for backfills where
 * atomicity with a customer INSERT is not required).
 */
export async function seedChecklistForCustomer(
  customerId: string,
  client?: PoolClient,
): Promise<void> {
  if (ONBOARDING_STEPS.length === 0) return;
  const values = ONBOARDING_STEPS.map((s, i) => {
    const base = i * 5;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  }).join(", ");
  const params: unknown[] = [];
  for (const s of ONBOARDING_STEPS) {
    params.push(randomUUID(), customerId, s.key, s.label, s.order);
  }
  const executor = client ?? pool;
  await executor.query(
    `INSERT INTO control_plane_onboarding_checklist (id, customer_id, step_key, step_label, step_order)
     VALUES ${values}
     ON CONFLICT (customer_id, step_key) DO NOTHING`,
    params,
  );
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

  // Backfill checklist rows for every existing customer that doesn't have them
  // yet (idempotent — seedChecklistForCustomer uses ON CONFLICT DO NOTHING).
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM control_plane_customers`,
  );
  for (const row of rows) {
    await seedChecklistForCustomer(row.id);
  }
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
  last_current_at: Date | null;
  last_status: string;
  last_latency_ms: number | null;
  last_seen_at: Date | null;
  last_error: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistRow {
  id: string;
  customer_id: string;
  step_key: string;
  step_label: string;
  step_order: number;
  is_done: boolean;
  done_at: Date | null;
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
