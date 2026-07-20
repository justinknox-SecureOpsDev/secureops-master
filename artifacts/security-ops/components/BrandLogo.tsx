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
 * The pre-connect screens (connect / org-code entry) intentionally keep the
 * fixed platform emblem via `SecureOpsLogo` instead of this component.
 */
export function BrandLogo({ size = 120 }: { size?: number }) {
  const { logoDataUrl, name } = useBrandLogo();
  return (
    <Image
      source={logoDataUrl ? { uri: logoDataUrl } : require("../assets/images/emblem.png")}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel={name}
    />
  );
}
