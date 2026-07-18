import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import { getApiBaseUrl } from "@/utils/api";
import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY } from "@/contexts/AuthContext";

/**
 * In-app account deletion (App Store Guideline 5.1.1(v)).
 *
 * A signed-in user can close their own account entirely within the app. We
 * re-collect the password as a deliberate, high-friction confirmation and then
 * call POST /auth/delete-account, which deactivates the account and revokes
 * every session server-side. The copy makes clear what is removed vs. what
 * employment records the company must legally retain.
 *
 * We use a raw fetch (not the shared apiRequest helper) so a wrong-password
 * 401 shows an inline retry instead of tripping the global auto-logout.
 */
export default function DeleteAccountScreen() {
  const colors = useColors();
  const router = useRouter();
  const { logout } = useAuth();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await storage.get(AUTH_TOKEN_KEY);
      const res = await fetch(`${getApiBaseUrl()}/auth/delete-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as any)?.message || "Could not delete your account. Please try again.");
        return;
      }
      // Success: the server has invalidated every session. Clear the local
      // session and send the user back to sign-in.
      await logout();
      Alert.alert(
        "Account deleted",
        "Your account has been closed and you've been signed out. If this was a mistake, contact your organization's HR to be re-invited.",
      );
      router.replace("/login");
    } catch (e: any) {
      setError(e?.message || "Can't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!password) {
      setError("Enter your password to confirm.");
      return;
    }
    Alert.alert(
      "Delete your account?",
      "This permanently closes your account and signs you out on every device. You won't be able to sign in again. This can't be undone from the app.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete account", style: "destructive", onPress: () => void submit() },
      ],
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]} accessibilityRole="header">
          Delete account
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.iconCircle, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "50" }]}>
          <Feather name="alert-triangle" size={26} color={colors.destructive} />
        </View>

        <Text style={[styles.lead, { color: colors.foreground }]}>
          Deleting your account closes it and removes your access
        </Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardHeading, { color: colors.accent }]}>WHAT HAPPENS</Text>
          <Bullet colors={colors} icon="log-out" text="You're signed out on every device and can no longer sign in." />
          <Bullet colors={colors} icon="bell-off" text="Push notifications and live location sharing stop immediately." />
          <Bullet colors={colors} icon="user-x" text="Your account is deactivated. To return, HR must re-invite you." />
        </View>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardHeading, { color: colors.accent }]}>WHAT IS RETAINED</Text>
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            As your employer, the company is legally required to keep certain records after
            your account is closed — such as employment, timekeeping, payroll and 1099 tax
            records, filed incident reports, and audit history — for the period required by
            law. These are retained by HR under the company retention policy and are no
            longer accessible from this app. To request a records review, contact HR.
          </Text>
        </View>

        <Text style={[styles.confirmLabel, { color: colors.foreground }]}>
          Enter your password to confirm
        </Text>
        <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
          <Feather name="lock" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.input, { color: colors.foreground }]}
            placeholder="Password"
            placeholderTextColor={colors.mutedForeground}
            value={password}
            onChangeText={(t) => { setPassword(t); if (error) setError(null); }}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            accessibilityLabel="Password"
          />
          <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
            <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.destructive + "25", borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={{ color: colors.destructive, fontSize: 13, flex: 1 }}>{error}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.deleteBtn, { backgroundColor: colors.destructive, opacity: busy || !password ? 0.6 : 1 }]}
          onPress={confirm}
          disabled={busy || !password}
          accessibilityRole="button"
          accessibilityLabel="Delete my account"
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Feather name="trash-2" size={16} color="#ffffff" />
              <Text style={styles.deleteBtnText}>Delete my account</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.back()} style={styles.cancelRow} accessibilityRole="button" accessibilityLabel="Keep my account">
          <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Keep my account</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Bullet({ colors, icon, text }: { colors: ReturnType<typeof useColors>; icon: any; text: string }) {
  return (
    <View style={styles.bulletRow}>
      <Feather name={icon} size={15} color={colors.mutedForeground} />
      <Text style={[styles.bulletText, { color: colors.foreground }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6 },
  title: { fontSize: 18, fontWeight: "700" },
  content: { padding: 20, gap: 16, paddingBottom: 60 },
  iconCircle: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, alignSelf: "center" },
  lead: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  card: { padding: 16, borderRadius: 12, borderWidth: 1, gap: 10 },
  cardHeading: { fontSize: 11, fontWeight: "700", letterSpacing: 2 },
  bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  bulletText: { flex: 1, fontSize: 14, lineHeight: 20 },
  note: { fontSize: 13, lineHeight: 19 },
  confirmLabel: { fontSize: 14, fontWeight: "600", marginTop: 4 },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 10, height: 50, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14 },
  input: { flex: 1, fontSize: 15 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  deleteBtn: { height: 50, borderRadius: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 4 },
  deleteBtnText: { color: "#ffffff", fontWeight: "700", fontSize: 15, letterSpacing: 0.5 },
  cancelRow: { alignItems: "center", paddingVertical: 10 },
  cancelText: { fontSize: 14, textDecorationLine: "underline" },
});
