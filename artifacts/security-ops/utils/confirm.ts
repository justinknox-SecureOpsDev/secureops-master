import { Alert, Platform } from "react-native";

/**
 * Cross-platform confirmation. On native, uses Alert.alert with Cancel/Confirm
 * buttons. On web (react-native-web), Alert.alert is unreliable for custom
 * button onPress callbacks inside iframes (the Replit canvas preview, in
 * particular), so we fall back to window.confirm — which actually fires.
 *
 * Resolves true when the user confirms, false when they cancel.
 */
export function confirmAction(opts: {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const { title, message, confirmText = "OK", cancelText = "Cancel", destructive } = opts;

  if (Platform.OS === "web") {
    const text = message ? `${title}\n\n${message}` : title;
    const ok = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(text)
      : true;
    return Promise.resolve(ok);
  }

  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelText, style: "cancel", onPress: () => resolve(false) },
      { text: confirmText, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
    ]);
  });
}

/** One-button info alert that works on web + native. */
export function notify(title: string, message?: string): void {
  if (Platform.OS === "web") {
    const text = message ? `${title}\n\n${message}` : title;
    if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(text);
    return;
  }
  Alert.alert(title, message);
}
