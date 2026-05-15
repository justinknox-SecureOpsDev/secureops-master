import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, ScrollView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useForgotPassword } from "@workspace/api-client-react";

export default function ForgotPasswordScreen() {
  const colors = useColors();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const mut = useForgotPassword();

  async function submit() {
    setError(null);
    if (!email.trim()) { setError("Please enter your email address"); return; }
    try {
      await mut.mutateAsync({ data: { email: email.trim() } });
      setSubmitted(true);
    } catch (e) {
      setError((e as Error).message || "Could not send reset link. Please try again.");
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.back()} style={styles.backRow}>
          <Feather name="chevron-left" size={20} color={colors.foreground} />
          <Text style={{ color: colors.foreground }}>Back to sign in</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <Feather name="key" size={28} color={colors.primary} />
          <Text style={[styles.title, { color: colors.foreground }]}>Forgot your password?</Text>
          <Text style={[styles.sub, { color: colors.mutedForeground }]}>
            Enter the email on your account and we'll send a secure link to choose a new password.
          </Text>
        </View>

        {submitted ? (
          <View style={[styles.successBox, { backgroundColor: colors.primary + "15", borderColor: colors.primary }]}>
            <Feather name="mail" size={20} color={colors.primary} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: colors.foreground, fontWeight: "700" }}>Check your email</Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 13, lineHeight: 18 }}>
                If an account exists for that email, a reset link is on its way. The link expires in 60 minutes.
              </Text>
            </View>
          </View>
        ) : (
          <>
            {error && (
              <View style={[styles.errorBox, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
                <Feather name="alert-circle" size={14} color={colors.destructive} />
                <Text style={{ color: colors.destructive, flex: 1, fontSize: 13 }}>{error}</Text>
              </View>
            )}

            <View style={{ gap: 6 }}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>Email address</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="you@example.com"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
              />
            </View>

            <TouchableOpacity
              onPress={submit}
              disabled={mut.isPending}
              style={[styles.button, { backgroundColor: colors.primary, opacity: mut.isPending ? 0.7 : 1 }]}
            >
              {mut.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Send reset link</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        <TouchableOpacity onPress={() => router.replace("/login")} style={{ alignSelf: "center", marginTop: 8 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>Return to sign in</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 16, paddingTop: Platform.OS === "web" ? 80 : 20, paddingBottom: 60 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  header: { gap: 8, marginBottom: 8 },
  title: { fontSize: 24, fontWeight: "700" },
  sub: { fontSize: 14, lineHeight: 20 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  successBox: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14, borderRadius: 10, borderWidth: 1 },
  label: { fontSize: 11, letterSpacing: 1, fontWeight: "700", textTransform: "uppercase" },
  input: { height: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, fontSize: 15 },
  button: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 8 },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});
