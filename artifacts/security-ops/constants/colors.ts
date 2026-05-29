/**
 * Brand color tokens — driven by EXPO_PUBLIC_BRAND_* env vars so each client
 * deployment gets its own palette. Falls back to WCSG defaults so the existing
 * production build needs no changes.
 *
 * EXPO_PUBLIC_BRAND_NAVY   Primary dark hex (e.g. "#0a0f1e")
 * EXPO_PUBLIC_BRAND_GOLD   Accent hex       (e.g. "#d4a843")
 * EXPO_PUBLIC_BRAND_CREAM  BG accent hex    (e.g. "#f5ead6")
 */

const NAVY  = process.env.EXPO_PUBLIC_BRAND_NAVY  ?? "#080c18";
const GOLD  = process.env.EXPO_PUBLIC_BRAND_GOLD  ?? "#c9a84c";
const CREAM = process.env.EXPO_PUBLIC_BRAND_CREAM ?? "#f0e6c8";

const shared = {
  text:                CREAM,
  tint:                GOLD,
  background:          NAVY,
  foreground:          CREAM,
  card:                "#0d1235",
  cardForeground:      CREAM,
  primary:             GOLD,
  primaryForeground:   NAVY,
  secondary:           "#141b3d",
  secondaryForeground: CREAM,
  muted:               "#141b3d",
  mutedForeground:     "#8a9bb8",
  accent:              "#e2b95a",
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
  border:              "#1c2550",
  input:               "#141b3d",
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
