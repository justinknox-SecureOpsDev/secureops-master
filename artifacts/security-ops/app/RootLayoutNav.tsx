import { Stack, useRouter, useSegments } from "expo-router";
import React, { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useNotifications } from "@/hooks/useNotifications";
import { Feather } from "@expo/vector-icons";

// Top-level routes the redirect guard must leave alone. Anything not in this
// set (and not inside (admin)/(employee)) gets bounced to the role landing
// page — that's how we keep deep links from leaking into the wrong shell.
// When you add a new top-level screen under `app/*.tsx`, add it here too,
// otherwise the button that opens it will just punt the user back to Home.
const ALLOWED_TOP_SCREENS = new Set([
  // Auth / first-login flows
  "login",
  "forgot-password",
  "change-password",
  "enable-biometric",
  "edit-profile",
  // Authenticated standalone screens reachable from profile / quick actions
  "availability",
  "license-renewal",
  "paystubs",
  "swap-requests",
  "training-add",
  "dar",
  "patrol",
  "notifications",
]);

export default function RootLayoutNav() {
  const { user, isLoading, awaitingBiometric, retryBiometric, cancelBiometric } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const colors = useColors();
  useNotifications();

  useEffect(() => {
    if (isLoading || awaitingBiometric) return;

    const top = segments[0] as string | undefined;
    const inAuthGroup = top === "(admin)" || top === "(employee)";

    if (!user) {
      if (top !== "login" && top !== "forgot-password") router.replace("/login");
      return;
    }

    // Force flows for first-login users.
    if (user.mustChangePassword && top !== "change-password") {
      router.replace("/change-password" as any);
      return;
    }
    if (!user.mustChangePassword && user.mustCompleteProfile && top !== "edit-profile" && top !== "enable-biometric") {
      router.replace("/edit-profile" as any);
      return;
    }

    // Leads share the admin shell but may ONLY manage scheduling — they are
    // confined to the (admin)/shifts stack. If a lead deep-links into any other
    // (admin) screen (payroll / invoices / dashboard / clients / employees / …)
    // or into the (employee) shell, bounce them back to Shifts. This is the
    // route-level half of the "lead sees no finance" invariant; the tab bar is
    // also pruned for leads in app/(admin)/_layout.tsx, and the React Query
    // cache is cleared on auth changes so no prior session's data lingers.
    if (user.role === "lead" && inAuthGroup) {
      const inShiftsStack = top === "(admin)" && (segments[1] as string | undefined) === "shifts";
      if (!inShiftsStack) {
        router.replace("/(admin)/shifts");
        return;
      }
    }

    // Default landing.
    if (!inAuthGroup && !ALLOWED_TOP_SCREENS.has(top ?? "")) {
      if (user.role === "lead") router.replace("/(admin)/shifts");
      else if (user.role === "admin") router.replace("/(admin)/dashboard");
      else router.replace("/(employee)/home");
    } else if (top === "login") {
      if (user.role === "lead") router.replace("/(admin)/shifts");
      else if (user.role === "admin") router.replace("/(admin)/dashboard");
      else router.replace("/(employee)/home");
    }
  }, [user, isLoading, awaitingBiometric, segments]);

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (awaitingBiometric) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: 24, gap: 16 }]}>
        <View style={[styles.iconCircle, { borderColor: colors.primary, backgroundColor: colors.primary + "15" }]}>
          <Feather name="lock" size={32} color={colors.primary} />
        </View>
        <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700" }}>{process.env.EXPO_PUBLIC_APP_NAME ?? "SecureOps"} locked</Text>
        <Text style={{ color: colors.mutedForeground, textAlign: "center", maxWidth: 280 }}>
          Use biometric to unlock, or sign in again with your password.
        </Text>
        <TouchableOpacity onPress={retryBiometric} style={[styles.btn, { backgroundColor: colors.primary }]}>
          <Text style={{ color: colors.primaryForeground, fontWeight: "700", letterSpacing: 1 }}>UNLOCK</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={cancelBiometric} style={{ padding: 10 }}>
          <Text style={{ color: colors.mutedForeground }}>Sign in with password</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="(admin)" />
      <Stack.Screen name="(employee)" />
      <Stack.Screen name="change-password" />
      <Stack.Screen name="enable-biometric" />
      <Stack.Screen name="edit-profile" />
      <Stack.Screen name="availability" />
      <Stack.Screen name="license-renewal" />
      <Stack.Screen name="paystubs" />
      <Stack.Screen name="swap-requests" />
      <Stack.Screen name="training-add" />
      <Stack.Screen name="dar" />
      <Stack.Screen name="patrol" />
      <Stack.Screen name="notifications" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  iconCircle: { width: 80, height: 80, borderRadius: 40, alignItems: "center", justifyContent: "center", borderWidth: 2 },
  btn: { paddingHorizontal: 28, height: 48, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
