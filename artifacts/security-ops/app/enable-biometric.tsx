import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import {
  isBiometricAvailable,
  setBiometricEnabled,
  promptBiometric,
} from "@/utils/biometric";

export default function EnableBiometricScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    isBiometricAvailable().then((a) => { if (!cancelled) setAvailable(a); });
    return () => { cancelled = true; };
  }, []);

  async function next() {
    if (user?.mustCompleteProfile) router.replace("/edit-profile" as any);
    else if (user?.role === "admin") router.replace("/(admin)/dashboard");
    else router.replace("/(employee)/home");
  }

  async function enable() {
    setBusy(true); setError(null);
    const ok = await promptBiometric("Confirm biometric to enable faster sign-in");
    if (ok) {
      await setBiometricEnabled(true);
      await next();
    } else {
      setError("Biometric not confirmed. You can try again or skip.");
    }
    setBusy(false);
  }

  async function skip() {
    await setBiometricEnabled(false);
    await next();
  }

  // If unsupported, just move on automatically.
  useEffect(() => {
    if (available === false) {
      setBiometricEnabled(false).then(() => { next().catch(() => {}); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  if (available === null || available === false) {
    return <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} />;
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, { borderColor: colors.primary, backgroundColor: colors.primary + "15" }]}>
          <Feather name={Platform.OS === "ios" ? "smile" : "unlock"} size={36} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Enable {Platform.OS === "ios" ? "Face ID / Touch ID" : "fingerprint"}?
        </Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>
          Use biometrics to unlock SecureOps faster. You can change this later.
        </Text>
        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
            <Text style={{ color: colors.destructive, fontSize: 13 }}>{error}</Text>
          </View>
        )}
        <TouchableOpacity
          onPress={enable}
          disabled={busy}
          style={[styles.button, { backgroundColor: colors.primary }]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Enable biometric unlock</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={skip} disabled={busy} style={styles.skip}>
          <Text style={{ color: colors.mutedForeground, fontWeight: "600" }}>Not now</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, padding: 24, justifyContent: "center", alignItems: "center", gap: 16 },
  iconCircle: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center", borderWidth: 2 },
  title: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  body: { fontSize: 14, textAlign: "center", lineHeight: 20, paddingHorizontal: 16 },
  errorBox: { padding: 12, borderRadius: 8, borderWidth: 1, alignSelf: "stretch" },
  button: { height: 50, paddingHorizontal: 24, borderRadius: 8, alignItems: "center", justifyContent: "center", alignSelf: "stretch", marginTop: 12 },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
  skip: { padding: 12 },
});
