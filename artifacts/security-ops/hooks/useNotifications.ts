import { useEffect } from "react";
import * as Notifications from "expo-notifications";
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

export function useNotifications() {
  const { user, token } = useAuth();

  useEffect(() => {
    if (!user || !token || Platform.OS === "web") return;
    registerForPushNotifications();
  }, [user, token]);
}

async function registerForPushNotifications() {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") return;

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: "security-ops",
    });

    if (tokenData.data) {
      await apiRequest("/auth/push-token", {
        method: "POST",
        body: JSON.stringify({ token: tokenData.data }),
      });
    }
  } catch (e) {
    // Notifications not available on web / simulator without credentials
    console.log("Push registration skipped:", e);
  }
}
