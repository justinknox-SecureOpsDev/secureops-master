import { Image } from "react-native";

/**
 * SecureOps Command — platform brand emblem (mobile).
 *
 * Renders the same SecureOps Command gold eagle seal as the web admin-portal
 * `SecureOpsLogo` so the shared sign-in screens match across the app and the
 * portal. This is the PLATFORM mark: every white-label tenant signs in through
 * the same SecureOps Command screen, and their own company branding only takes
 * over after authentication — so the emblem is fixed to the platform seal
 * rather than the per-tenant brand tokens.
 */
export function SecureOpsLogo({ size = 120 }: { size?: number }) {
  return (
    <Image
      source={require("../assets/images/emblem.png")}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel="SecureOps Command"
    />
  );
}
