import { useColorScheme } from "react-native";

import colors from "@/constants/colors";
import { useAccessibility } from "@/contexts/AccessibilityContext";

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 *
 * When the officer has enabled the high-contrast accessibility option
 * (Profile → Accessibility), this hook returns the pure-black high-contrast
 * palette instead — boosting every text/background pairing above WCAG AA for
 * use in bright sun and for low-vision users.
 *
 * Otherwise it falls back to the light palette when no dark key is defined in
 * constants/colors.ts (the scaffold ships light-only by default). When a
 * sibling web artifact's dark tokens are synced into a `dark` key, this hook
 * will switch palettes based on the device's appearance setting.
 */
export function useColors() {
  const scheme = useColorScheme();
  const { highContrast } = useAccessibility();
  if (highContrast) {
    return { ...colors.highContrast, radius: colors.radius };
  }
  const palette =
    scheme === "dark" && "dark" in colors
      ? (colors as unknown as Record<string, typeof colors.light>).dark
      : colors.light;
  return { ...palette, radius: colors.radius };
}
