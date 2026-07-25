import { Stack, useRouter, useSegments, useGlobalSearchParams } from "expo-router";
import React, { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useOrg } from "@/contexts/OrgContext";
import { normalizeOrgCode, isValidOrgCode } from "@/utils/orgConfig";
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet, Platform } from "react-native";
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
  "delete-account",
  "sign-policies",
  // Authenticated standalone screens reachable from profile / quick actions
  "availability",
  "license-renewal",
  "paystubs",
  "time-card",
  "policies",
  "payment-discrepancy",
  "swap-requests",
  "training-add",
  "dar",
  "patrol",
  "notifications",
]);

export default function RootLayoutNav() {
  const { user, isLoading, awaitingBiometric, retryBiometric, cancelBiometric } = useAuth();
  const { org } = useOrg();
  const segments = useSegments();
  const params = useGlobalSearchParams<{ code?: string | string[] }>();
  const router = useRouter();
  const colors = useColors();
  useNotifications();

  // An invite link / QR encodes the target org as a `?code=` query on the
  // /connect deep link. A VALID such param (even while already connected) means
  // an org-switch is in flight, so the guard must leave /connect alone. We
  // validate the code here so a junk/crafted `?code=` can never pry /connect
  // open for an already-connected user — only a syntactically valid code does.
  const rawPendingCode = Array.isArray(params.code) ? params.code[0] : params.code;
  const pendingOrgCode =
    rawPendingCode && isValidOrgCode(normalizeOrgCode(rawPendingCode))
      ? rawPendingCode
      : undefined;

  useEffect(() => {
    if (isLoading || awaitingBiometric) return;

    const top = segments[0] as string | undefined;

    // Multi-org gate (native only): no backend selected yet → force the
    // /connect screen BEFORE any auth routing. Web always talks to its own
    // same origin, so it never needs org selection. (OrgProvider already holds
    // rendering until the stored org is applied, so reaching here with a null
    // org means a genuine first-run / post-switch state.)
    if (Platform.OS !== "web" && !org) {
      if (top !== "connect") router.replace("/connect" as any);
      return;
    }

    // Already connected, but an invite link / QR carrying a `?code=` landed us
    // on /connect → let the connect screen handle the switch prompt instead of
    // bouncing the user back to their landing page. Without a code param,
    // /connect stays unreachable once an org is set (manual switch lives in the
    // Profile / login "Switch" action), so first-run routing is unchanged.
    if (Platform.OS !== "web" && top === "connect" && pendingOrgCode) {
      return;
    }

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
    // After password + profile, non-admins must sign company policies once.
    // The flag is never set for admins, so this never gates them.
    if (!user.mustChangePassword && !user.mustCompleteProfile && user.mustSignPolicies && user.role !== "admin" && top !== "sign-policies") {
      router.replace("/sign-policies" as any);
      return;
    }

    // A site manager is a full employee PLUS scheduling powers — they land in the
    // normal (employee) shell (Home / My Shifts / Clock / Incidents / Chat /
    // Radio / Profile) and reach scheduling via the site manager-only Schedule tab
    // (app/(employee)/schedule, which re-exports the admin shift screens).
    // No special redirect: site managers are treated exactly like employees here.

    // Default landing.
    if (!inAuthGroup && !ALLOWED_TOP_SCREENS.has(top ?? "")) {
      if (user.role === "admin") router.replace("/(admin)/dashboard");
      else router.replace("/(employee)/home");
    } else if (top === "login") {
      if (user.role === "admin") router.replace("/(admin)/dashboard");
      else router.replace("/(employee)/home");
    }
  }, [user, isLoading, awaitingBiometric, segments, org, pendingOrgCode]);

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
      <Stack.Screen name="connect" />
      <Stack.Screen name="login" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="(admin)" />
      <Stack.Screen name="(employee)" />
      <Stack.Screen name="change-password" />
      <Stack.Screen name="enable-biometric" />
      <Stack.Screen name="edit-profile" />
      <Stack.Screen name="delete-account" />
      <Stack.Screen name="sign-policies" />
      <Stack.Screen name="availability" />
      <Stack.Screen name="license-renewal" />
      <Stack.Screen name="paystubs" />
      <Stack.Screen name="time-card" />
      <Stack.Screen name="policies" />
      <Stack.Screen name="payment-discrepancy" />
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
