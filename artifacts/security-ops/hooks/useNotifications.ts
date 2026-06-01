import { useEffect, useRef } from "react";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/utils/api";
import { setupNotificationDeepLinking } from "./notificationDeepLink";
import { registerForPushNotifications as runPushRegistration } from "./pushRegistration";

// Detect Expo Go. SDK 53 removed remote-push support in Expo Go on Android
// and the `expo-notifications` module logs a red-box ERROR at *import time*
// when loaded there — not when its APIs are called. That means we cannot
// statically `import "expo-notifications"` at the top of this file in Expo Go,
// or the error fires regardless of any runtime guard. We dynamic-import it
// only in environments that actually support remote push.
const isExpoGo = Constants.appOwnership === "expo";

function getEasProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId
  );
}

export function useNotifications() {
  const { user, token } = useAuth();
  const router = useRouter();

  // Keep the latest role in a ref so the long-lived notification-response
  // listener routes taps into the correct navigation group without being
  // re-created every time the user object changes identity.
  const roleRef = useRef<string | undefined>(user?.role);
  useEffect(() => { roleRef.current = user?.role; }, [user?.role]);

  useEffect(() => {
    if (!user || !token || Platform.OS === "web") return;
    void runPushRegistration({
      platformOS: Platform.OS,
      isExpoGo,
      getProjectId: getEasProjectId,
      loadNotifications: async () => {
        const Notifications = await import("expo-notifications");
        return {
          setNotificationHandler: (handler) =>
            Notifications.setNotificationHandler(
              handler as Parameters<typeof Notifications.setNotificationHandler>[0],
            ),
          setNotificationChannelAsync: (channelId, channel) =>
            Notifications.setNotificationChannelAsync(
              channelId,
              channel as Parameters<typeof Notifications.setNotificationChannelAsync>[1],
            ),
          AndroidImportance: { MAX: Notifications.AndroidImportance.MAX },
          getPermissionsAsync: () => Notifications.getPermissionsAsync(),
          requestPermissionsAsync: () => Notifications.requestPermissionsAsync(),
          getExpoPushTokenAsync: (options) => Notifications.getExpoPushTokenAsync(options),
        };
      },
      postPushToken: async (pushToken) => {
        await apiRequest("/auth/push-token", {
          method: "POST",
          body: JSON.stringify({ token: pushToken }),
        });
      },
    });
  }, [user, token]);

  // Deep-link any notification tap to a sensible target screen — chat rooms,
  // shifts, the clock, license/training renewal, swap requests, and the admin
  // incident/map/employee views. Warm taps (app foreground/background) come
  // through the response listener; cold-start taps (app was killed) come
  // through getLastNotificationResponseAsync. Unknown/legacy notifications fall
  // back to the default landing screen by doing nothing here.
  useEffect(() => {
    return setupNotificationDeepLinking({
      platformOS: Platform.OS,
      isExpoGo,
      getRole: () => roleRef.current,
      push: (target) =>
        router.push({ pathname: target.pathname as never, params: target.params }),
      loadNotifications: async () => {
        const Notifications = await import("expo-notifications");
        return {
          getLastNotificationResponseAsync: () =>
            Notifications.getLastNotificationResponseAsync(),
          addNotificationResponseReceivedListener: (listener) =>
            Notifications.addNotificationResponseReceivedListener((response) =>
              listener(response),
            ),
        };
      },
    });
  }, [router]);
}
