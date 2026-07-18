// The slice of `expo-notifications` the push-registration flow depends on.
// Keeping it narrow lets the hook adapt the real module and lets tests inject a
// fake without pulling expo-notifications (which red-boxes at import in Expo Go).
export type PermissionStatusLike = { status: string };

export type PushRegistrationModule = {
  setNotificationHandler: (handler: unknown) => void;
  setNotificationChannelAsync: (channelId: string, channel: unknown) => Promise<unknown>;
  AndroidImportance: { MAX: number };
  getPermissionsAsync: () => Promise<PermissionStatusLike>;
  requestPermissionsAsync: () => Promise<PermissionStatusLike>;
  getExpoPushTokenAsync: (options: { projectId: string }) => Promise<{ data: string }>;
};

export type RegisterForPushNotificationsDeps = {
  /** `Platform.OS` — drives Android-only notification-channel setup. */
  platformOS: string;
  /** True in Expo Go, where expo-notifications cannot be imported. */
  isExpoGo: boolean;
  /** Resolves the EAS project id required to mint an Expo push token. */
  getProjectId: () => string | undefined;
  /** Lazily loads expo-notifications (dynamic import in the hook). */
  loadNotifications: () => Promise<PushRegistrationModule>;
  /** Persists the resolved push token to the backend. */
  postPushToken: (token: string) => Promise<void>;
};

// Registers this device for remote push: configures the notification handler
// (+ Android channels), requests OS permission, resolves the EAS project id,
// mints an Expo push token, and POSTs it to the backend. Returns the token that
// was registered, or null when registration was skipped/declined for any
// reason (Expo Go, no permission, missing project id, empty token). No-ops
// silently in Expo Go, where importing expo-notifications red-boxes. Any
// unexpected failure is swallowed (logged) and returns null so push
// registration never crashes app startup.
export async function registerForPushNotifications(
  deps: RegisterForPushNotificationsDeps,
): Promise<string | null> {
  const { platformOS, isExpoGo, getProjectId, loadNotifications, postPushToken } = deps;

  try {
    if (isExpoGo) {
      // Skip silently in Expo Go — importing expo-notifications here would
      // trigger its own red-box error on Android.
      return null;
    }

    const Notifications = await loadNotifications();

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

    if (platformOS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#c9a04a",
        sound: "default",
      });
      await Notifications.setNotificationChannelAsync("emergency", {
        name: "Emergency alerts",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500],
        lightColor: "#ef4444",
        sound: "default",
        bypassDnd: true,
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return null;

    const projectId = getProjectId();
    if (!projectId) return null;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    if (tokenData.data) {
      await postPushToken(tokenData.data);
      return tokenData.data;
    }
    return null;
  } catch (e) {
    console.log("Push registration skipped:", e);
    return null;
  }
}
