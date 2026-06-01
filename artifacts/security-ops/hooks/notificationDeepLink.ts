import { resolveNotificationTarget } from "./resolveNotificationTarget";

// A notification response as the deep-link wiring needs to see it. This is a
// structural subset of expo-notifications' `NotificationResponse` so the hook
// can pass the real module through an adapter while tests pass a fake.
export type NotificationResponseLike = {
  notification: { request: { content: { data: unknown } } };
};

// The slice of `expo-notifications` the deep-link wiring depends on. Keeping it
// narrow lets the hook adapt the real module and lets tests inject a fake
// without pulling expo-notifications (which red-boxes at import in Expo Go).
export type NotificationsResponseModule = {
  getLastNotificationResponseAsync: () => Promise<NotificationResponseLike | null>;
  addNotificationResponseReceivedListener: (
    listener: (response: NotificationResponseLike) => void,
  ) => { remove: () => void };
};

export type DeepLinkPushTarget = { pathname: string; params: Record<string, string> };

export type SetupNotificationDeepLinkingDeps = {
  /** `Platform.OS` — used to skip listener registration on web. */
  platformOS: string;
  /** True in Expo Go, where expo-notifications cannot be imported. */
  isExpoGo: boolean;
  /** Reads the latest recipient role (kept in a ref by the hook). */
  getRole: () => string | undefined;
  /** Performs the actual navigation (router.push in the hook). */
  push: (target: DeepLinkPushTarget) => void;
  /** Lazily loads expo-notifications (dynamic import in the hook). */
  loadNotifications: () => Promise<NotificationsResponseModule>;
  /** Clock for the per-tap highlight nonce. Defaults to Date.now. */
  now?: () => number;
  /** Cold-start defer so the root redirect guard lands first. */
  coldStartDelayMs?: number;
};

// Wires notification taps to deep-link navigation. Warm taps (foreground/
// background) arrive via the response listener; cold-start taps (app was
// killed) arrive via getLastNotificationResponseAsync, deferred briefly so the
// root redirect guard finishes first. Returns a cleanup function that cancels
// any pending cold-start navigation and removes the listener. No-ops (returns a
// bare cleanup) on web and in Expo Go, where no listener should be registered.
export function setupNotificationDeepLinking(
  deps: SetupNotificationDeepLinkingDeps,
): () => void {
  const {
    platformOS,
    isExpoGo,
    getRole,
    push,
    loadNotifications,
    now = Date.now,
    coldStartDelayMs = 800,
  } = deps;

  if (platformOS === "web" || isExpoGo) return () => {};

  let cancelled = false;
  let subscription: { remove: () => void } | undefined;

  const navigateForNotification = (data: unknown): void => {
    const target = resolveNotificationTarget(data, getRole());
    if (!target) return;
    // Stamp a per-tap nonce so the destination screen re-fires its scroll-to /
    // highlight effect even when the same item is tapped twice in a row.
    const params = { ...(target.params ?? {}), _hlTs: String(now()) };
    push({ pathname: target.pathname, params });
  };

  void (async () => {
    try {
      const Notifications = await loadNotifications();

      const last = await Notifications.getLastNotificationResponseAsync();
      if (!cancelled && last) {
        setTimeout(() => {
          if (!cancelled) navigateForNotification(last.notification.request.content.data);
        }, coldStartDelayMs);
      }

      if (cancelled) return;
      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        navigateForNotification(response.notification.request.content.data);
      });
    } catch (e) {
      console.log("Notification response listener skipped:", e);
    }
  })();

  return () => {
    cancelled = true;
    subscription?.remove();
  };
}
