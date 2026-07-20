/**
 * Brand color tokens — driven by EXPO_PUBLIC_BRAND_* env vars so each client
 * deployment gets its own palette. Falls back to WCSG defaults so the existing
 * production build needs no changes.
 *
 * EXPO_PUBLIC_BRAND_NAVY   Primary dark hex (e.g. "#0a0f1e")
 * EXPO_PUBLIC_BRAND_GOLD   Accent hex       (e.g. "#d4a843")
 * EXPO_PUBLIC_BRAND_CREAM  BG accent hex    (e.g. "#f5ead6")
 */

const NAVY  = process.env.EXPO_PUBLIC_BRAND_NAVY  ?? "#0c0a08";
const GOLD  = process.env.EXPO_PUBLIC_BRAND_GOLD  ?? "#c9a04a";
const CREAM = process.env.EXPO_PUBLIC_BRAND_CREAM ?? "#f0e4c0";

/** The build-time (env / WCSG default) brand colors — pre-fetch fallback. */
export const ENV_BRAND_COLORS = { navy: NAVY, gold: GOLD, cream: CREAM };

const shared = {
  text:                CREAM,
  tint:                GOLD,
  background:          NAVY,
  foreground:          CREAM,
  card:                "#1f1a15",
  cardForeground:      CREAM,
  primary:             GOLD,
  primaryForeground:   NAVY,
  secondary:           "#2a241d",
  secondaryForeground: CREAM,
  muted:               "#2a241d",
  mutedForeground:     "#aca395",
  accent:              "#f0d89a",
  accentForeground:    NAVY,
  destructive:         "#c0392b",
  // Foreground for text/icons placed ON a solid `destructive` fill (buttons).
  // Pure white keeps WCAG AA (~5:1) on the #c0392b fill.
  destructiveForeground: "#ffffff",
  // Semantic "go / on-duty / success" green. Used both as colored text on dark
  // surfaces (passes AA on navy) and as a solid button fill — in which case
  // `successForeground` is the legible text/icon color to place on top.
  success:             "#22c55e",
  successForeground:   "#06250f",
  border:              "#3a3229",
  input:               "#2a241d",
};

/**
 * High-contrast palette for officers working outdoors / in bright sun and for
 * low-vision users. Pure-black surfaces with white text and saturated accents
 * push every text/background pairing well above WCAG AA (4.5:1):
 *   - white (#ffffff) on black (#000000)            ≈ 21:1
 *   - light grey (#e6e6e6) on black                 ≈ 16:1
 *   - bright gold (#ffd23f) on black                ≈ 14:1
 *   - bright red (#ff5b4a) on black                 ≈ 5.6:1
 * Borders are brightened to stay visible against pure black.
 */
const highContrast: typeof shared = {
  text:                "#ffffff",
  tint:                "#ffd23f",
  background:          "#000000",
  foreground:          "#ffffff",
  card:                "#000000",
  cardForeground:      "#ffffff",
  primary:             "#ffd23f",
  primaryForeground:   "#000000",
  secondary:           "#161616",
  secondaryForeground: "#ffffff",
  muted:               "#161616",
  mutedForeground:     "#e6e6e6",
  accent:              "#ffd23f",
  accentForeground:    "#000000",
  destructive:         "#ff5b4a",
  destructiveForeground: "#000000",
  // Brighter green for text on black (≈ 13:1); black foreground on the fill.
  success:             "#3ef07a",
  successForeground:   "#000000",
  border:              "#9a9a9a",
  input:               "#161616",
};

const colors = {
  light: shared,
  dark:  shared,
  highContrast,
  radius: 8,
};

export default colors;

export type Palette = typeof shared;
export type BrandColors = { navy: string; gold: string; cream: string };

/* ------------------------------------------------------------------------ *
 * Dynamic per-tenant palette derivation.
 *
 * The shared app-store build serves many customer orgs; once an org is
 * connected the app adopts that org's three brand colors fetched live from
 * GET /api/brand. The derived tokens below (card, secondary, muted, border,
 * accent, foregrounds, …) are computed from the org's navy/gold/cream by
 * luminance-aware mixing so ANY tenant palette produces a coherent, legible
 * theme.
 *
 * IMPORTANT: when the inputs equal the build-time defaults (WCSG), the
 * hand-tuned `shared` palette above is returned VERBATIM — WCSG deployments
 * stay pixel-identical and the mobile a11y gate keeps holding.
 * ------------------------------------------------------------------------ */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two hex colors: t=0 → a, t=1 → b. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Legible text color (near-black or white) for a solid fill. */
function onColor(fill: string): string {
  return contrastRatio(fill, "#111111") >= contrastRatio(fill, "#ffffff")
    ? "#111111"
    : "#ffffff";
}

function sanitizeBrandColors(input: Partial<BrandColors> | null | undefined): BrandColors {
  const pick = (v: unknown, fallback: string) =>
    typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : fallback;
  return {
    navy: pick(input?.navy, NAVY),
    gold: pick(input?.gold, GOLD),
    cream: pick(input?.cream, CREAM),
  };
}
export { sanitizeBrandColors };

/**
 * Build the full token palette from a tenant's three brand colors.
 * With the build-time default inputs this returns the hand-tuned palette
 * unchanged (exact same values as today).
 */
export function derivePalette(input: BrandColors): Palette {
  const { navy, gold, cream } = sanitizeBrandColors(input);
  if (
    navy === NAVY.toLowerCase() &&
    gold === GOLD.toLowerCase() &&
    cream === CREAM.toLowerCase()
  ) {
    return shared;
  }

  const bgIsDark = luminance(navy) < 0.35;
  // Surfaces elevate toward the cream when it reads against the background
  // (brand-tinted charcoals/papers); otherwise toward plain white/black.
  const surfaceTarget =
    contrastRatio(navy, cream) >= 2 ? cream : bgIsDark ? "#ffffff" : "#000000";

  // Foreground: prefer the brand cream when legible on the background.
  const foreground =
    contrastRatio(navy, cream) >= 4.5 ? cream : bgIsDark ? "#ffffff" : "#1a1a1a";

  let mutedForeground = mix(foreground, navy, 0.3);
  if (contrastRatio(mutedForeground, navy) < 4.5) {
    mutedForeground = mix(foreground, navy, 0.12);
  }

  const primaryForeground =
    contrastRatio(gold, navy) >= 4.5 ? navy : onColor(gold);

  const accent = bgIsDark ? mix(gold, "#ffffff", 0.35) : mix(gold, "#000000", 0.2);
  const accentForeground =
    contrastRatio(accent, navy) >= 4.5 ? navy : onColor(accent);

  return {
    text:                foreground,
    tint:                gold,
    background:          navy,
    foreground,
    card:                mix(navy, surfaceTarget, 0.09),
    cardForeground:      foreground,
    primary:             gold,
    primaryForeground,
    secondary:           mix(navy, surfaceTarget, 0.14),
    secondaryForeground: foreground,
    muted:               mix(navy, surfaceTarget, 0.14),
    mutedForeground,
    accent,
    accentForeground,
    destructive:         shared.destructive,
    destructiveForeground: shared.destructiveForeground,
    success:             shared.success,
    successForeground:   shared.successForeground,
    border:              mix(navy, surfaceTarget, 0.22),
    input:               mix(navy, surfaceTarget, 0.14),
  };
}
