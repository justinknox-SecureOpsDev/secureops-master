/**
 * Mobile feature-flag + brand hook. Mirrors the admin portal's `isFeatureEnabled`
 * helper. Fetches GET /api/brand at app boot, caches in module state AND
 * persists on-device keyed to the connected backend, and exposes:
 *   - a synchronous `isFeatureEnabled` for tab gating,
 *   - `useBrand` for per-tenant text (company name / short name / tagline / app name),
 *   - `useBrandColors` for the org's three brand colors (drives useColors), and
 *   - `useBrandLogo` for the org's uploaded logo data URL.
 *
 * All feature keys default to ENABLED — only an explicit `false` from the server
 * hides the feature. Owner controls via DISABLED_FEATURES env on the API.
 *
 * Brand text/colors/logo are per-tenant: because ONE shared app build serves
 * every customer, the app must show the CONNECTED backend's branding — never a
 * value baked into the build. The generic `ENV_BRAND` (SecureOps Command) and
 * the build-time colors are only a pre-fetch / offline fallback.
 *
 * Relaunch behavior: the persisted copy is hydrated (see OrgContext, which
 * awaits `hydrateBrandFromStorage()` inside its init barrier on native) so a
 * reconnected org renders its own branding immediately, then a background
 * fetch refreshes it — no flash of the default WCSG look.
 */

import { useEffect, useState } from "react";
import { getApiBaseUrl, hasRuntimeApiOrigin, isReactNative } from "@/utils/api";
import { storage } from "@/utils/storage";
import {
  ENV_BRAND_COLORS,
  sanitizeBrandColors,
  type BrandColors,
} from "@/constants/colors";

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

type BrandPayload = {
  features: Flags;
  brand: BrandText;
  colors: BrandColors;
  /** Org's uploaded logo (data:image/* URI) — null falls back to the platform emblem. */
  logoDataUrl: string | null;
};

function envPayload(): BrandPayload {
  return {
    features: {},
    brand: ENV_BRAND,
    colors: ENV_BRAND_COLORS,
    logoDataUrl: null,
  };
}

let cached: BrandPayload | null = null;
let inFlight: Promise<void> | null = null;
/** True once a LIVE fetch for the current backend has settled successfully. */
let fetchedFresh = false;

const listeners = new Set<() => void>();
function notify(): void {
  listeners.forEach((l) => l());
}

/**
 * Persisted cache is keyed to the backend base URL, so each org's brand is
 * stored separately and a relaunch renders the connected org's look instantly.
 */
const BRAND_CACHE_PREFIX = "org_brand_cache:";
function brandCacheKey(): string {
  return `${BRAND_CACHE_PREFIX}${getApiBaseUrl()}`;
}

/**
 * On native, only fetch/serve tenant brand once an org backend is applied —
 * before any org is connected the app keeps the neutral SecureOps Command
 * platform look (connect screen). Web always talks to its own tenant origin.
 */
function brandActive(): boolean {
  return !isReactNative() || hasRuntimeApiOrigin();
}

function buildPayload(data: unknown): BrandPayload {
  const d = (data ?? {}) as Partial<BrandText> & {
    features?: Flags;
    colorNavy?: string;
    colorGold?: string;
    colorCream?: string;
    logoDataUrl?: string | null;
  };
  const logo = typeof d.logoDataUrl === "string" && d.logoDataUrl.startsWith("data:image/")
    ? d.logoDataUrl
    : null;
  return {
    features: d.features ?? {},
    brand: {
      companyName: d.companyName || ENV_BRAND.companyName,
      shortName: d.shortName || ENV_BRAND.shortName,
      tagline: d.tagline || ENV_BRAND.tagline,
      companyLicense: d.companyLicense || "",
      appName: d.appName || ENV_BRAND.appName,
    },
    colors: sanitizeBrandColors({
      navy: d.colorNavy,
      gold: d.colorGold,
      cream: d.colorCream,
    }),
    logoDataUrl: logo,
  };
}

/**
 * Eagerly fetch + persist the connected org's brand immediately after an org
 * is selected (selectOrg / selectDefaultOrg), so the login screen renders in
 * tenant colors with no flash of the default WCSG look.
 *
 * Re-uses the existing in-flight promise when one is already running. Never
 * throws — fetchFresh catches errors internally and falls back to envPayload.
 * Callers should still `.catch(() => {})` defensively.
 */
export async function prefetchBrand(): Promise<void> {
  if (!brandActive()) return;
  if (!inFlight) {
    inFlight = fetchFresh().finally(() => {
      inFlight = null;
    });
  }
  await inFlight;
}

/**
 * Read-only view of the in-memory brand cache (null before any hydrate/fetch).
 * Exists so tests can assert the "no flash" invariant: after selectOrg awaits
 * prefetchBrand, this MUST already hold the tenant's brand before the login
 * screen mounts. Not for rendering — use the hooks, which subscribe to updates.
 */
export function getCachedBrandSnapshot(): Readonly<BrandPayload> | null {
  return cached;
}

/**
 * Drop the cached flags + brand so the next read re-fetches from the CURRENT
 * backend. MUST be called when the selected organization changes (see
 * OrgContext) — otherwise the previous org's flags/brand leak into the new one.
 */
export function resetFeatureFlagsCache(): void {
  cached = null;
  inFlight = null;
  fetchedFresh = false;
  notify();
}

/** Remove the persisted brand for the CURRENTLY applied backend (org switch). */
export async function clearPersistedBrand(): Promise<void> {
  await storage.remove(brandCacheKey());
}

/**
 * Hydrate the in-memory cache from the persisted copy for the current backend.
 * OrgContext awaits this inside its native init barrier so a relaunch renders
 * the connected org's branding with no flash of the default look.
 */
export async function hydrateBrandFromStorage(): Promise<void> {
  if (cached || !brandActive()) return;
  const raw = await storage.get(brandCacheKey());
  if (!raw || cached) return;
  try {
    const parsed = JSON.parse(raw) as Partial<BrandPayload>;
    if (!parsed || typeof parsed !== "object") return;
    cached = {
      features: parsed.features ?? {},
      brand: { ...ENV_BRAND, ...(parsed.brand ?? {}) },
      colors: sanitizeBrandColors(parsed.colors),
      logoDataUrl:
        typeof parsed.logoDataUrl === "string" &&
        parsed.logoDataUrl.startsWith("data:image/")
          ? parsed.logoDataUrl
          : null,
    };
    notify();
  } catch {
    // Corrupt cache — ignore; the live fetch will rewrite it.
  }
}

async function fetchFresh(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${getApiBaseUrl()}/brand`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    cached = buildPayload(data);
    fetchedFresh = true;
    void storage.set(brandCacheKey(), JSON.stringify(cached));
    notify();
  } catch {
    if (!cached) {
      cached = envPayload();
      notify();
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function load(): Promise<BrandPayload> {
  if (!brandActive()) return cached ?? envPayload();
  if (!cached) await hydrateBrandFromStorage();
  if (!fetchedFresh && !inFlight) {
    inFlight = fetchFresh().finally(() => {
      inFlight = null;
    });
  }
  // Serve the hydrated/previous copy immediately; the live fetch refreshes in
  // the background and notifies subscribers when it lands.
  if (cached) return cached;
  if (inFlight) await inFlight;
  return cached ?? envPayload();
}

function useBrandPayload(): BrandPayload {
  const [payload, setPayload] = useState<BrandPayload>(cached ?? envPayload());
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setPayload(cached ?? envPayload());
    };
    listeners.add(sync);
    void load().then(sync);
    return () => {
      cancelled = true;
      listeners.delete(sync);
    };
  }, []);
  return payload;
}

export function useFeatures(): Flags {
  return useBrandPayload().features;
}

/** Per-tenant brand text (falls back to ENV_BRAND). */
export function useBrand(): BrandText {
  return useBrandPayload().brand;
}

/** The connected org's brand colors (falls back to build-time defaults). */
export function useBrandColors(): BrandColors {
  return useBrandPayload().colors;
}

/** The connected org's uploaded logo + display name (logo null = platform emblem). */
export function useBrandLogo(): { logoDataUrl: string | null; name: string } {
  const p = useBrandPayload();
  return { logoDataUrl: p.logoDataUrl, name: p.brand.companyName };
}

export function isEnabled(flags: Flags, key: FeatureKey): boolean {
  return flags[key] !== false;
}

/** Convenience: subscribe to a single feature flag (defaults to enabled). */
export function useFeature(key: FeatureKey): boolean {
  const flags = useFeatures();
  return isEnabled(flags, key);
}
