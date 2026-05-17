import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/utils/api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Resolve the EAS projectId from app config. Hard-coding the slug here breaks
// getExpoPushTokenAsync on Android — Expo's push service needs the real UUID.
function getEasProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId
  );
}

async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
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

export function useNotifications() {
  const { user, token } = useAuth();

  useEffect(() => {
    if (!user || !token || Platform.OS === "web") return;
    registerForPushNotifications();
  }, [user, token]);
}

async function registerForPushNotifications() {
  try {
    await ensureAndroidChannel();

    // Expo SDK 53+ removed remote push support from Expo Go on Android.
    // Calling getExpoPushTokenAsync there throws a noisy error. Detect Expo
    // Go and skip silently — push only works in dev/preview/production builds.
    if (Constants.appOwnership === "expo") {
      console.log("Push registration skipped: running in Expo Go (remote push requires a dev build)");
      return;
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") return;

    const projectId = getEasProjectId();
    if (!projectId) {
      console.log("Push registration skipped: no EAS projectId in app config");
      return;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });

    if (tokenData.data) {
      await apiRequest("/auth/push-token", {
        method: "POST",
        body: JSON.stringify({ token: tokenData.data }),
      });
    }
  } catch (e) {
    // Notifications not available on web / simulator without credentials.
    // Logged at info level so it doesn't surface as a red error overlay.
    console.log("Push registration skipped:", e);
  }
}
