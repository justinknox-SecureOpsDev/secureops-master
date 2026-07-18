/**
 * Mobile feature-flag + brand hook. Mirrors the admin portal's `isFeatureEnabled`
 * helper. Fetches GET /api/brand once at app boot, caches in module state, and
 * exposes a synchronous `isFeatureEnabled` for tab gating plus a `useBrand` hook
 * for per-tenant text (company name / short name / tagline / app name).
 *
 * All feature keys default to ENABLED — only an explicit `false` from the server
 * hides the feature. Owner controls via DISABLED_FEATURES env on the API.
 *
 * Brand text is per-tenant: because ONE shared app build serves every customer,
 * post-auth surfaces (chat header, profile footer) must show the CONNECTED
 * backend's company name — never a value baked into the build. The generic
 * `ENV_BRAND` (SecureOps Command) is only a pre-fetch / offline fallback.
 */

import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/utils/api";

/**
 * Adding a new paid/optional feature — 3-step convention (must do all three):
 *
 *   1. Router file — add `requireFeature("<key>")` on the relevant path(s).
 *   2. routes/index.ts — list the router in SELF_GATED_ROUTERS.
 *   3. routes/index.ts — add an entry in FEATURE_ENDPOINTS so the gating
 *      integration test (featureGating.test.ts) probes the new surface.
 *
 * To add the key itself, edit lib/feature-keys/src/index.ts (single source of
 * truth). The FeatureKey type here is re-exported from that shared package —
 * no other files need editing.
 *
 * See artifacts/api-server/src/__tests__/featureGating.test.ts for the
 * automated guard that enforces steps 1–3 stay in sync.
 */
import type { FeatureKey } from "@workspace/feature-keys";
export type { FeatureKey } from "@workspace/feature-keys";

type Flags = Partial<Record<FeatureKey, boolean>>;

export type BrandText = {
  companyName: string;
  shortName: string;
  tagline: string;
  /** Company/state license line (e.g. "TX DPS Lic. #B12345"); empty = hidden. */
  companyLicense: string;
  appName: string;
};

/** Generic product brand — pre-fetch / offline fallback, never tenant-specific. */
const ENV_BRAND: BrandText = {
  companyName: process.env.EXPO_PUBLIC_COMPANY_NAME ?? "SecureOps Command",
  shortName: process.env.EXPO_PUBLIC_COMPANY_SHORT_NAME ?? "SecureOps",
  tagline: process.env.EXPO_PUBLIC_TAGLINE ?? "",
  companyLicense: "",
  appName: process.env.EXPO_PUBLIC_APP_NAME ?? "SecureOps",
};

type BrandPayload = { features: Flags; brand: BrandText };

let cached: BrandPayload | null = null;
let inFlight: Promise<BrandPayload> | null = null;

/**
 * Drop the cached flags + brand so the next read re-fetches from the CURRENT
 * backend. MUST be called when the selected organization changes (see
 * OrgContext) — otherwise the previous org's flags/brand leak into the new one.
 */
export function resetFeatureFlagsCache(): void {
  cached = null;
  inFlight = null;
}

async function load(): Promise<BrandPayload> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/brand`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Partial<BrandText> & { features?: Flags };
      cached = {
        features: data.features ?? {},
        brand: {
          companyName: data.companyName || ENV_BRAND.companyName,
          shortName: data.shortName || ENV_BRAND.shortName,
          tagline: data.tagline || ENV_BRAND.tagline,
          companyLicense: data.companyLicense || "",
          appName: data.appName || ENV_BRAND.appName,
        },
      };
    } catch {
      cached = { features: {}, brand: ENV_BRAND };
    }
    return cached;
  })();
  return inFlight;
}

export function useFeatures(): Flags {
  const [flags, setFlags] = useState<Flags>(cached?.features ?? {});
  useEffect(() => {
    let cancelled = false;
    load().then((d) => { if (!cancelled) setFlags(d.features); });
    return () => { cancelled = true; };
  }, []);
  return flags;
}

/** Per-tenant brand text for post-auth surfaces (falls back to ENV_BRAND). */
export function useBrand(): BrandText {
  const [brand, setBrand] = useState<BrandText>(cached?.brand ?? ENV_BRAND);
  useEffect(() => {
    let cancelled = false;
    load().then((d) => { if (!cancelled) setBrand(d.brand); });
    return () => { cancelled = true; };
  }, []);
  return brand;
}

export function isEnabled(flags: Flags, key: FeatureKey): boolean {
  return flags[key] !== false;
}

/** Convenience: subscribe to a single feature flag (defaults to enabled). */
export function useFeature(key: FeatureKey): boolean {
  const flags = useFeatures();
  return isEnabled(flags, key);
}
