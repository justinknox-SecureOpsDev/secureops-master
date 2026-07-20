import { Image } from "react-native";

import { useBrandLogo } from "@/hooks/useFeatures";

/**
 * Brand-aware logo for the connected organization.
 *
 * Renders the org's uploaded logo (data:image/* URI from GET /api/brand,
 * cached on-device) when present, and falls back to the SecureOps Command
 * platform emblem otherwise. The accessibility label follows the org's
 * company name so screen readers announce the right brand.
 *
 * Uploaded logos are rendered as-is — no backing plate. A plate behind logos
 * with their own baked-in background (like the WCSG eagle) shows as ugly
 * white edges; if a tenant ever uploads a dark-on-transparent logo that's
 * illegible on a dark background, handle it with a flag computed from the
 * actual image pixels at upload time, not a color heuristic here.
 *
 * The pre-connect screens (connect / org-code entry) intentionally keep the
 * fixed platform emblem via `SecureOpsLogo` instead of this component.
 */
export function BrandLogo({ size = 120 }: { size?: number }) {
  const { logoDataUrl, name } = useBrandLogo();

  if (!logoDataUrl) {
    return (
      <Image
        source={require("../assets/images/emblem.png")}
        style={{ width: size, height: size }}
        resizeMode="contain"
        accessibilityLabel={name}
      />
    );
  }

  return (
    <Image
      source={{ uri: logoDataUrl }}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel={name}
    />
  );
}
