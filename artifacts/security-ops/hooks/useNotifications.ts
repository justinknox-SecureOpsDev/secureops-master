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

  // Deep-link any notification tap to a sensible target screen — chat rooms,
  // shifts, the clock, license/training renewal, swap requests, and the admin
  // incident/map/employee views. Warm taps (app foreground/background) come
  // through the response listener; cold-start taps (app was killed) come
  // through getLastNotificationResponseAsync. Unknown/legacy notifications fall
  // back to the default landing screen by doing nothing here.
  useEffect(() => {
    if (Platform.OS === "web" || isExpoGo) return;

    let cancelled = false;
    let subscription: { remove: () => void } | undefined;

    const navigateForNotification = (data: unknown): void => {
      const target = resolveNotificationTarget(data, roleRef.current);
      if (!target) return;
      router.push({ pathname: target.pathname as never, params: target.params });
    };

    void (async () => {
      try {
        const Notifications = await import("expo-notifications");

        // Cold start: the app was launched by tapping a notification. Defer
        // briefly so the root redirect guard finishes landing the user inside
        // their role group before we push the target route on top of it.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (!cancelled && last) {
          setTimeout(() => {
            if (!cancelled) navigateForNotification(last.notification.request.content.data);
          }, 800);
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
  }, [router]);
}

type NavTarget = { pathname: string; params?: Record<string, string> };

// Map a push notification's `data` payload + the recipient's role to a deep-link
// target. Returns null for unknown/legacy notifications so the caller falls back
// to the default landing screen. Senders set `data.type`; the legacy missed-
// patrol push used `data.kind`, so we honour that too.
function resolveNotificationTarget(data: unknown, role: string | undefined): NavTarget | null {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d) return null;
  const type =
    typeof d.type === "string" ? d.type : typeof d.kind === "string" ? d.kind : undefined;
  if (!type) return null;

  const group = role === "admin" ? "(admin)" : "(employee)";
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

  switch (type) {
    // Chat — deep-link into the room so the header can be labelled.
    case "chat_message": {
      if (!d.roomId) return null;
      return {
        pathname: `/${group}/chat/[id]`,
        params: { id: String(d.roomId), name: d.roomName ? String(d.roomName) : "Chat" },
      };
    }

    // Shift lifecycle — assignment, reservation, open vacancy, pre-shift
    // reminder all live on the shifts tab (admin or employee).
    case "shift_assigned":
    case "shift_reserved":
    case "shift_available":
    case "shift_vacancy_reminder":
    case "shift_reminder":
      return { pathname: `/${group}/shifts` };

    // Clock — forgot-to-clock-out nudge.
    case "forgot_clock_out":
      return { pathname: "/(employee)/clock" };

    // License / training renewal.
    case "license_expiry_reminder":
      return { pathname: "/license-renewal" };
    case "training_expiry_reminder":
      return { pathname: "/training-add" };

    // Shift swaps — request, accept/decline, approval/rejection, cancellation.
    case "swap-request":
    case "swap-update":
    case "swap-approved":
    case "swap-rejected":
    case "swap-cancelled":
      return { pathname: "/swap-requests" };
    // Admin gets pinged when an officer-to-officer swap needs approval.
    case "swap-pending-approval":
      return role === "admin" ? { pathname: "/swap-requests" } : null;

    // Admin-only alerts. These are only sent to admins; guard on role so a
    // stray payload never routes a non-admin into the admin tab group.
    case "emergency":
      return role === "admin" ? { pathname: "/(admin)/incidents" } : null;
    case "geofence_breach":
    case "missed_checkpoint":
      return role === "admin" ? { pathname: "/(admin)/live-map" } : null;
    case "high_risk_profile_change": {
      if (role !== "admin") return null;
      const id = str(d.employeeUserId);
      return id
        ? { pathname: "/(admin)/employees/[id]", params: { id } }
        : { pathname: "/(admin)/employees" };
    }

    default:
      return null;
  }
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
