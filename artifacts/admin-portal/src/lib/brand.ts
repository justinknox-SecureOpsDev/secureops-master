/**
 * Brand configuration client for the admin portal.
 *
 * The API server exposes GET /api/brand (public, no auth). We fetch it once on
 * app load and stash the result on window.__BRAND__ so that even non-React
 * pages (Legal.tsx, BrandHeader.tsx) can read it synchronously.
 *
 * A small in-memory cache means repeated calls are free after the first fetch.
 */

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

export type FeatureFlags = Partial<Record<FeatureKey, boolean>>;

export type BrandConfig = {
  companyName: string;
  shortName:   string;
  tagline:     string;
  appName:     string;
  colorNavy:   string;
  colorGold:   string;
  colorCream:  string;
  logoDataUrl?: string | null;
  features?:   FeatureFlags;
};

const WCSG_DEFAULTS: BrandConfig = {
  companyName: "Williams Council Security Group",
  shortName:   "WCSG",
  tagline:     "Professional Security Services",
  appName:     "SecureOps",
  colorNavy:   "#0c0a08",
  colorGold:   "#c9a04a",
  colorCream:  "#f0e4c0",
  logoDataUrl: null,
  features:    {},
};

let cached: BrandConfig | null = null;

/** WCAG relative luminance for an 8-bit RGB triple. */
function relLum(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Derive a WCAG-AA "gold ink" — a darkened gold safe as normal TEXT on the
 * light/cream admin surfaces (e.g. Legal.tsx prose links, which sit on the
 * default cream #f0e4c0). Progressively darkens the given gold until it clears
 * 4.6:1 against cream — the lightest place gold text appears (white cards are
 * easier, so cream is the worst case). This is contrast-targeted rather than a
 * fixed multiplier so it stays AA for ANY super-admin gold, including brighter
 * ones where a flat darken would fall short.
 */
function goldInk(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  const creamLum = relLum(240, 228, 192); // #f0e4c0
  const onCream = () => (creamLum + 0.05) / (relLum(r, g, b) + 0.05);
  for (let i = 0; i < 40 && onCream() < 4.6; i++) {
    r = Math.round(r * 0.94);
    g = Math.round(g * 0.94);
    b = Math.round(b * 0.94);
  }
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * Push the brand palette into CSS custom properties so the `.brand-*` /
 * `.bg-brand-*` utility classes (defined in index.css) reflect a super-admin's
 * live colour edits. Only sets a var when a colour is present, so the env/CSS
 * defaults remain the fallback.
 */
export function applyBrandColors(b: BrandConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (b.colorNavy)  root.style.setProperty("--brand-navy", b.colorNavy);
  if (b.colorCream) root.style.setProperty("--brand-cream", b.colorCream);
  if (b.colorGold) {
    root.style.setProperty("--brand-gold", b.colorGold);
    root.style.setProperty("--brand-gold-ink", goldInk(b.colorGold));
  }
}

/**
 * Reflect the live brand in the browser tab title. The static index.html title
 * is a neutral, tenant-agnostic fallback ("Admin Portal") — a white-label tenant
 * must never show another tenant's name in the tab. Once /api/brand resolves we
 * set the real, brand-aware title here.
 */
export function applyBrandDocumentTitle(b: BrandConfig): void {
  if (typeof document === "undefined") return;
  document.title = `${b.companyName} — Admin Portal`;
}

export async function fetchBrand(): Promise<BrandConfig> {
  if (cached) return cached;
  let fetched = false;
  try {
    const res = await fetch("/api/brand");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cached = await res.json() as BrandConfig;
    fetched = true;
  } catch {
    cached = WCSG_DEFAULTS;
  }
  (window as any).__BRAND__ = cached;
  applyBrandColors(cached);
  // Only brand the tab when /api/brand actually resolved. On failure we fall
  // back to WCSG_DEFAULTS for colours/data, but the title must stay neutral —
  // otherwise one tenant's name (WCSG) would leak into another tenant's tab
  // during a brand-API outage. Keep the tenant-agnostic "Admin Portal".
  if (fetched) {
    applyBrandDocumentTitle(cached);
  } else if (typeof document !== "undefined") {
    document.title = "Admin Portal";
  }
  return cached;
}

/** Force a re-fetch of /api/brand — call after a super-admin updates flags or branding. */
export async function refreshBrand(): Promise<BrandConfig> {
  cached = null;
  return fetchBrand();
}

/** Synchronous read — returns the cached value or WCSG defaults. */
export function getBrand(): BrandConfig {
  return (window as any).__BRAND__ ?? WCSG_DEFAULTS;
}

/**
 * Synchronous feature-flag check. All keys default to ENABLED — only an
 * explicit `false` from the server hides the feature. This means newly
 * added features show up automatically on older deployments.
 */
export function isFeatureEnabled(key: keyof NonNullable<BrandConfig["features"]>): boolean {
  const flags = getBrand().features;
  return flags?.[key] !== false;
}
