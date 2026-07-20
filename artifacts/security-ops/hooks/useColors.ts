import { useMemo } from "react";

import colors, { derivePalette } from "@/constants/colors";
import { useAccessibility } from "@/contexts/AccessibilityContext";
import { useBrandColors } from "@/hooks/useFeatures";

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 *
 * When the officer has enabled the high-contrast accessibility option
 * (Profile → Accessibility), this hook returns the pure-black high-contrast
 * palette instead — boosting every text/background pairing above WCAG AA for
 * use in bright sun and for low-vision users. High contrast is FIXED: it never
 * follows tenant brand colors.
 *
 * Otherwise the palette is derived live from the CONNECTED org's brand colors
 * (fetched from that backend's GET /api/brand and cached on-device — see
 * hooks/useFeatures). Before any org is connected, and for WCSG deployments
 * (whose fetched colors equal the build-time defaults), this returns the
 * hand-tuned build-time palette unchanged.
 */
export function useColors() {
  const { highContrast } = useAccessibility();
  const brandColors = useBrandColors();
  const palette = useMemo(
    () => derivePalette(brandColors),
    [brandColors.navy, brandColors.gold, brandColors.cream],
  );
  if (highContrast) {
    return { ...colors.highContrast, radius: colors.radius };
  }
  return { ...palette, radius: colors.radius };
}
