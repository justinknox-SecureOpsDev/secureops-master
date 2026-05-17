import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Top padding for screens that render their own custom header (i.e. tabs
 * with `headerShown: false` or modal screens). On web we keep a fixed 67px
 * gap for the WCSG brand bar. On native we respect the device's top safe
 * area inset (status bar / dynamic island) so headers don't get clipped
 * on iPhone Pro Max and similar devices.
 */
export function useTopPad(): number {
  const insets = useSafeAreaInsets();
  if (Platform.OS === "web") return 67;
  return insets.top;
}
