import { Image, View } from "react-native";

import { useBrandColors } from "@/hooks/useFeatures";
import { contrastRatio } from "@/constants/colors";
import { useBrandLogo } from "@/hooks/useFeatures";

/**
 * Brand-aware logo for the connected organization.
 *
 * Renders the org's uploaded logo (data:image/* URI from GET /api/brand,
 * cached on-device) when present, and falls back to the SecureOps Command
 * platform emblem otherwise. The accessibility label follows the org's
 * company name so screen readers announce the right brand.
 *
 * When a custom logo is displayed we add a light backing plate behind it so
 * that logos designed for light backgrounds (dark text / transparent PNG)
 * remain legible on any tenant's dark login surface. The plate is skipped
 * when the computed contrast between a white plate and the tenant's background
 * color is low (i.e. the background is already light), which also keeps the
 * WCSG emblem path completely unchanged.
 *
 * The pre-connect screens (connect / org-code entry) intentionally keep the
 * fixed platform emblem via `SecureOpsLogo` instead of this component.
 */
export function BrandLogo({ size = 120 }: { size?: number }) {
  const { logoDataUrl, name } = useBrandLogo();
  const brandColors = useBrandColors();

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

  // A white plate on a dark background has high contrast — show the plate.
  // A white plate on a light background has low contrast — hide the plate.
  const needsPlate = contrastRatio("#ffffff", brandColors.navy) >= 3;

  const padding = Math.round(size * 0.1);
  const plateSize = size + padding * 2;
  const borderRadius = Math.round(size * 0.12);

  if (needsPlate) {
    return (
      <View
        style={{
          width: plateSize,
          height: plateSize,
          borderRadius,
          backgroundColor: "rgba(255,255,255,0.92)",
          alignItems: "center",
          justifyContent: "center",
        }}
        accessible={false}
      >
        <Image
          source={{ uri: logoDataUrl }}
          style={{ width: size, height: size }}
          resizeMode="contain"
          accessibilityLabel={name}
        />
      </View>
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
