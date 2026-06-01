import { useEffect, useRef } from "react";
import { Animated } from "react-native";

// Drives a one-shot "flash" animation used to visually highlight the exact item
// a user lands on after tapping a push notification. Returns an Animated.Value
// that snaps to 1 when `triggerKey` changes (a fresh tap), holds for `holdMs`,
// then eases back to 0. Consumers interpolate it into border/background colours
// on the single matching row/marker.
//
// `triggerKey` must change on every tap that should re-flash — callers compose
// it from the target id plus a per-navigation timestamp (e.g. `${id}:${ts}`) so
// tapping the same item twice in a row still re-highlights it. Pass null/empty
// to stay dormant (no id in the payload, or nothing to highlight).
export function useHighlightFlash(
  triggerKey: string | null | undefined,
  holdMs = 1800,
): Animated.Value {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!triggerKey) return;
    anim.stopAnimation();
    anim.setValue(1);
    const timer = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: 700,
        // Colour interpolation is not supported by the native driver.
        useNativeDriver: false,
      }).start();
    }, holdMs);
    return () => clearTimeout(timer);
  }, [triggerKey, anim, holdMs]);

  return anim;
}
