import { useEffect } from "react";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/utils/api";

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

  useEffect(() => {
    if (!user || !token || Platform.OS === "web") return;
    void registerForPushNotifications();
  }, [user, token]);
}

async function registerForPushNotifications() {
  try {
    if (isExpoGo) {
      // Skip silently in Expo Go — importing expo-notifications here would
      // trigger its own red-box error on Android.
      return;
    }

    const Notifications = await import("expo-notifications");

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#c9a84c",
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
    if (finalStatus !== "granted") return;

    const projectId = getEasProjectId();
    if (!projectId) return;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    if (tokenData.data) {
      await apiRequest("/auth/push-token", {
        method: "POST",
        body: JSON.stringify({ token: tokenData.data }),
      });
    }
  } catch (e) {
    console.log("Push registration skipped:", e);
  }
}
