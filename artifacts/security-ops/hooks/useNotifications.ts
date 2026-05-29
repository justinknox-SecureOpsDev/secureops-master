import { useEffect, useRef } from "react";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
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
  const router = useRouter();

  // Keep the latest role in a ref so the long-lived notification-response
  // listener routes taps into the correct navigation group without being
  // re-created every time the user object changes identity.
  const roleRef = useRef<string | undefined>(user?.role);
  useEffect(() => { roleRef.current = user?.role; }, [user?.role]);

  useEffect(() => {
    if (!user || !token || Platform.OS === "web") return;
    void registerForPushNotifications();
  }, [user, token]);

  // Deep-link chat-message notification taps straight into the room. Warm taps
  // (app foreground/background) come through the response listener; cold-start
  // taps (app was killed) come through getLastNotificationResponseAsync.
  useEffect(() => {
    if (Platform.OS === "web" || isExpoGo) return;

    let cancelled = false;
    let subscription: { remove: () => void } | undefined;

    const navigateToRoom = (data: unknown): void => {
      const d = data as { type?: string; roomId?: string; roomName?: string } | null | undefined;
      if (!d || d.type !== "chat_message" || !d.roomId) return;
      const group = roleRef.current === "admin" ? "(admin)" : "(employee)";
      router.push({
        pathname: `/${group}/chat/[id]` as never,
        params: { id: String(d.roomId), name: d.roomName ? String(d.roomName) : "Chat" },
      });
    };

    void (async () => {
      try {
        const Notifications = await import("expo-notifications");

        // Cold start: the app was launched by tapping a notification. Defer
        // briefly so the root redirect guard finishes landing the user inside
        // their role group before we push the chat route on top of it.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (!cancelled && last) {
          setTimeout(() => {
            if (!cancelled) navigateToRoom(last.notification.request.content.data);
          }, 800);
        }

        if (cancelled) return;
        subscription = Notifications.addNotificationResponseReceivedListener((response) => {
          navigateToRoom(response.notification.request.content.data);
        });
      } catch (e) {
        console.log("Notification response listener skipped:", e);
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [router]);
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
