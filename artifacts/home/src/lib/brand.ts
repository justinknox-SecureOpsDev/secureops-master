/**
 * Brand configuration client for the public marketing site.
 *
 * The API server exposes GET /api/brand (public, no auth). The marketing site
 * is served from the same domain (/home/), so a relative fetch reaches it in
 * production. We resolve it once before first paint and stash the result on
 * window.__BRAND__ so the (otherwise static) page components can read it
 * synchronously and stay white-label without prop drilling.
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

const DEFAULTS: BrandConfig = {
  companyName: "Williams Council Security Group",
  shortName:   "WCSG",
  tagline:     "Professional Security Services",
  appName:     "SecureOps",
  colorNavy:   "#0c0a08",
  colorGold:   "#c9a04a",
  colorCream:  "#f0e4c0",
};

/** Resolve /api/brand once, falling back to WCSG defaults on any error. */
export async function loadBrand(): Promise<BrandConfig> {
  let cfg = DEFAULTS;
  try {
    const res = await fetch("/api/brand");
    if (res.ok) cfg = { ...DEFAULTS, ...(await res.json()) };
  } catch {
    // offline / API down — keep defaults
  }
  (window as any).__BRAND__ = cfg;
  return cfg;
}

/** Synchronous read — returns the resolved value or WCSG defaults. */
export function getBrand(): BrandConfig {
  return (window as any).__BRAND__ ?? DEFAULTS;
}
