/**
 * Feature flags — owner-controlled toggles that drive pricing tiers.
 *
 * Two layers, checked in order (last wins):
 *   1. `DISABLED_FEATURES` env var (CSV) — baseline disabled set at boot.
 *   2. `platform_feature_overrides` DB rows — runtime overrides set by a
 *      super-admin via the admin portal. Each row pins one key to
 *      explicitly true or false and beats the env baseline.
 *
 * Add a new flag here, gate its router in routes/index.ts, and consumers
 * pick it up automatically through GET /api/brand.
 */

import type { RequestHandler } from "express";
import { db, platformFeatureOverridesTable } from "@workspace/db";
import { FEATURE_KEYS, type FeatureKey } from "@workspace/feature-keys";
export { FEATURE_KEYS } from "@workspace/feature-keys";
export type { FeatureKey } from "@workspace/feature-keys";

/**
 * Adding a new paid/optional feature — 3-step convention (must do all three):
 *
 *   1. Router file — add `requireFeature("<key>")` on the relevant path(s).
 *   2. routes/index.ts — list the router in SELF_GATED_ROUTERS.
 *   3. routes/index.ts — add an entry in FEATURE_ENDPOINTS so the gating
 *      integration test (featureGating.test.ts) probes the new surface.
 *
 * To add the key itself, edit lib/feature-keys/src/index.ts (single source of
 * truth). The FeatureKey union in admin-portal and security-ops is derived from
 * that array automatically — no other files need editing.
 *
 * See artifacts/api-server/src/__tests__/featureGating.test.ts for the
 * automated guard that enforces steps 1–3 stay in sync.
 */

const ENV_DISABLED: Set<string> = new Set(
  (process.env["DISABLED_FEATURES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// In-memory override cache, refreshed from DB at boot and after every
// super-admin write. Sync access from `isFeatureEnabled` keeps the
// per-request middleware hot path allocation-free.
const overrides: Map<FeatureKey, boolean> = new Map();

export function isFeatureEnabled(key: FeatureKey): boolean {
  const override = overrides.get(key);
  if (override !== undefined) return override;
  return !ENV_DISABLED.has(key);
}

export function getFeatureFlags(): Record<FeatureKey, boolean> {
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = isFeatureEnabled(k);
  return out;
}

/**
 * Return the resolved state of every feature along with its source so the
 * super-admin UI can show "from env" vs "overridden in DB".
 */
export function getFeatureFlagDetails(): Array<{
  key: FeatureKey;
  enabled: boolean;
  source: "override" | "env";
  envDisabled: boolean;
}> {
  return FEATURE_KEYS.map((k) => {
    const override = overrides.get(k);
    return {
      key: k,
      enabled: override !== undefined ? override : !ENV_DISABLED.has(k),
      source: override !== undefined ? "override" : "env",
      envDisabled: ENV_DISABLED.has(k),
    };
  });
}

export async function loadFeatureOverridesFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(platformFeatureOverridesTable);
    overrides.clear();
    for (const row of rows) {
      if ((FEATURE_KEYS as readonly string[]).includes(row.featureKey)) {
        overrides.set(row.featureKey as FeatureKey, row.enabled);
      }
    }
  } catch {
    // Table might not exist on first boot before `db push` — leave overrides empty.
  }
}

export function setOverrideInMemory(key: FeatureKey, enabled: boolean): void {
  overrides.set(key, enabled);
}

export function clearOverrideInMemory(key: FeatureKey): void {
  overrides.delete(key);
}

/**
 * Express middleware: 403 if `key` is disabled. Re-checks on every request
 * so super-admin toggles take effect immediately without server restart.
 */
export function requireFeature(key: FeatureKey): RequestHandler {
  return (_req, res, next) => {
    if (!isFeatureEnabled(key)) {
      res.status(403).json({
        error: "Forbidden",
        message: `Feature '${key}' is not enabled in this deployment.`,
        feature: key,
      });
      return;
    }
    next();
  };
}
