import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Platform, Linking, Alert,
  AccessibilityInfo, findNodeHandle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useListActivePolicies, useAcknowledgePolicies } from "@workspace/api-client-react";
import type { PolicyPublic } from "@workspace/api-client-react";

/**
 * Mandatory first-login gate for non-admin staff: they must read and
 * acknowledge company policies once (typed full legal name + checkbox) before
 * reaching the app. Reached only when `user.mustSignPolicies` is true — admins
 * are never flagged. No back button (like the mandatory change-password flow).
 *
 * Lockout-safe: the active-policy list is informational. Even if it can't load
 * (e.g. the policies feature is disabled on this tenant) or is empty, the user
 * can still record their acknowledgement and continue — the acknowledge
 * endpoint is not feature-gated and clears the flag regardless.
 */
export default function SignPoliciesScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user, updateUser } = useAuth();

  const [signature, setSignature] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const nameRef = React.useRef<TextInput>(null);

  const { data, isLoading, isError } = useListActivePolicies();
  const policies = (data ?? []) as PolicyPublic[];
  const mut = useAcknowledgePolicies();

  function focusName() {
    const t = nameRef.current;
    if (!t) return;
    const node = findNodeHandle(t);
    if (node != null) { try { AccessibilityInfo.setAccessibilityFocus?.(node); } catch { /* best effort */ } }
    try { t.focus?.(); } catch { /* best effort */ }
  }

  async function openPolicy(p: PolicyPublic) {
    if (!p.viewUrl) {
      Alert.alert("Unavailable", "This policy has no document attached yet.");
      return;
    }
    try {
      setOpening(p.id);
      const can = await Linking.canOpenURL(p.viewUrl);
      if (can) await Linking.openURL(p.viewUrl);
      else Alert.alert("Cannot open", "No app available to open this document.");
    } catch {
      Alert.alert("Error", "Could not open the policy document.");
    } finally {
      setOpening(null);
    }
  }

  async function submit() {
    setError(null);
    const name = signature.trim();
    if (name.length < 2) {
      const msg = "Please type your full legal name to sign.";
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      focusName();
      return;
    }
    if (!agreed) {
      const msg = "Please check the box to confirm you have read and agree.";
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      return;
    }
    try {
      const resp = await mut.mutateAsync({ data: { signature: name } });
      // Server echoes the updated user; merge it, then defensively clear the
      // flag locally so the navigator stops routing back to this screen.
      await updateUser(resp);
      await updateUser({ mustSignPolicies: false });
      router.replace((user?.role === "admin" ? "/(admin)/dashboard" : "/(employee)/home") as any);
    } catch (e) {
      const msg = (e as Error).message || "Could not record your acknowledgement. Please try again.";
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Feather name="shield" size={28} color={colors.primary} />
          <Text style={[styles.title, { color: colors.foreground }]} accessibilityRole="header">
            Company policies
          </Text>
          <Text style={[styles.sub, { color: colors.mutedForeground }]}>
            Welcome{user?.firstName ? `, ${user.firstName}` : ""}. Please review the company
            policies below, then type your full legal name and confirm to continue.
          </Text>
        </View>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={{ color: colors.destructive, flex: 1, fontSize: 13 }}>{error}</Text>
          </View>
        )}

        {isLoading ? (
          <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
        ) : isError ? (
          <View style={[styles.note, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="info" size={16} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, flex: 1, fontSize: 13, lineHeight: 18 }}>
              Policy documents could not be loaded right now. You can still record your
              acknowledgement and continue.
            </Text>
          </View>
        ) : policies.length === 0 ? (
          <View style={[styles.note, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="info" size={16} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, flex: 1, fontSize: 13, lineHeight: 18 }}>
              There are no policy documents to review at this time. Confirm below to continue.
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {policies.map((p) => {
              const busy = opening === p.id;
              const hasDoc = !!p.viewUrl;
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => void openPolicy(p)}
                  disabled={busy || !hasDoc}
                  style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border, opacity: hasDoc ? 1 : 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open policy ${p.label}`}
                  accessibilityHint={hasDoc ? "Opens the policy document" : "No document attached"}
                >
                  <Feather name="file-text" size={20} color={colors.accent} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: colors.foreground }]}>{p.label}</Text>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                      {p.fileName ?? "No document"} · v{p.version}
                    </Text>
                  </View>
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Feather name={hasDoc ? "external-link" : "slash"} size={16} color={colors.mutedForeground} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={{ gap: 6, marginTop: 4 }}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Full legal name *</Text>
          <TextInput
            ref={nameRef}
            value={signature}
            onChangeText={(v) => { setSignature(v); if (error) setError(null); }}
            placeholder="Type your full legal name"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="words"
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
            accessibilityLabel="Full legal name, required"
          />
        </View>

        <TouchableOpacity
          onPress={() => { setAgreed((a) => !a); if (error) setError(null); }}
          style={styles.checkRow}
          accessibilityRole="checkbox"
          accessibilityLabel="I confirm I have read and agree to the company policies"
          accessibilityState={{ checked: agreed }}
        >
          <Feather name={agreed ? "check-square" : "square"} size={22} color={agreed ? colors.primary : colors.mutedForeground} />
          <Text style={{ color: colors.foreground, flex: 1, fontSize: 14, lineHeight: 20 }}>
            I confirm I have read, understood, and agree to abide by the company policies.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={submit}
          disabled={mut.isPending}
          style={[styles.button, { backgroundColor: colors.primary, opacity: mut.isPending ? 0.7 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel="Sign and continue"
          accessibilityState={{ disabled: mut.isPending, busy: mut.isPending }}
        >
          {mut.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Sign &amp; continue</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 16, paddingTop: Platform.OS === "web" ? 80 : 20, paddingBottom: 60 },
  header: { gap: 8, marginBottom: 4 },
  title: { fontSize: 24, fontWeight: "700" },
  sub: { fontSize: 14, lineHeight: 20 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  center: { padding: 40, alignItems: "center" },
  note: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 10, borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 12, borderWidth: 1 },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  rowMeta: { fontSize: 12, marginTop: 2 },
  label: { fontSize: 11, letterSpacing: 1, fontWeight: "700", textTransform: "uppercase" },
  input: { height: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, fontSize: 15 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  button: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 8 },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});
