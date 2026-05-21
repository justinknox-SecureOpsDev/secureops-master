/**
 * Brand configuration client for the admin portal.
 *
 * The API server exposes GET /api/brand (public, no auth). We fetch it once on
 * app load and stash the result on window.__BRAND__ so that even non-React
 * pages (Legal.tsx, BrandHeader.tsx) can read it synchronously.
 *
 * A small in-memory cache means repeated calls are free after the first fetch.
 */

export type BrandConfig = {
  companyName: string;
  shortName:   string;
  tagline:     string;
  appName:     string;
  colorNavy:   string;
  colorGold:   string;
  colorCream:  string;
};

const WCSG_DEFAULTS: BrandConfig = {
  companyName: "Williams Council Security Group",
  shortName:   "WCSG",
  tagline:     "Professional Security Services",
  appName:     "SecureOps",
  colorNavy:   "#080c18",
  colorGold:   "#c9a84c",
  colorCream:  "#f0e6c8",
};

let cached: BrandConfig | null = null;

export async function fetchBrand(): Promise<BrandConfig> {
  if (cached) return cached;
  try {
    const res = await fetch("/api/brand");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cached = await res.json() as BrandConfig;
  } catch {
    cached = WCSG_DEFAULTS;
  }
  (window as any).__BRAND__ = cached;
  return cached;
}

/** Synchronous read — returns the cached value or WCSG defaults. */
export function getBrand(): BrandConfig {
  return (window as any).__BRAND__ ?? WCSG_DEFAULTS;
}
