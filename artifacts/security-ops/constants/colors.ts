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
  destructiveForeground: CREAM,
  border:              "#1c2550",
  input:               "#141b3d",
};

const colors = {
  light: shared,
  dark:  shared,
  radius: 8,
};

export default colors;
