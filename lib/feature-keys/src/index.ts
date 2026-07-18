/**
 * Single source of truth for the WCSG feature-key registry.
 *
 * Both the admin portal and the mobile app import `FeatureKey` from here.
 * The API server also imports `FEATURE_KEYS` from here and derives its own
 * `FeatureKey` type, keeping all three in sync automatically.
 *
 * Adding a new paid/optional feature — 3-step convention (must do all three):
 *
 *   1. Router file — add `requireFeature("<key>")` on the relevant path(s).
 *   2. routes/index.ts — list the router in SELF_GATED_ROUTERS.
 *   3. routes/index.ts — add an entry in FEATURE_ENDPOINTS so the gating
 *      integration test (featureGating.test.ts) probes the new surface.
 *   4. HERE — add the key to FEATURE_KEYS. The FeatureKey union in both
 *      client packages is derived from this array automatically; no other
 *      files need to be edited.
 *
 * See artifacts/api-server/src/__tests__/featureGating.test.ts for the
 * automated guard that enforces steps 1–3 stay in sync.
 */
export const FEATURE_KEYS = [
  "chat",
  "radio",
  "incidents",
  "payroll",
  "invoicing",
  "hr",
  "liveMap",
  "policies",
  "swapRequests",
  "licenseRenewals",
  "dar",
  "exports",
  "trainings",
  "patrol",
  "availability",
  "officerShares",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
