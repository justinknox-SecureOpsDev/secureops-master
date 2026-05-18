import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, ScrollView, Platform,
  AccessibilityInfo, findNodeHandle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useChangePassword } from "@workspace/api-client-react";

export default function ChangePasswordScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user, updateUser, setToken, login } = useAuth();
  const params = useLocalSearchParams<{ mode?: string }>();
  const isMandatory = user?.mustChangePassword === true;
  const isSelfService = params.mode === "self";

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type FieldErrors = { current: string | null; next: string | null; confirm: string | null };
  const noErrors: FieldErrors = { current: null, next: null, confirm: null };
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(noErrors);
  const currentRef = React.useRef<TextInput>(null);
  const nextRef = React.useRef<TextInput>(null);
  const confirmRef = React.useRef<TextInput>(null);
  const mut = useChangePassword();

  function fail(errors: FieldErrors, summary: string, target: React.RefObject<TextInput | null>) {
    setFieldErrors(errors);
    setError(summary);
    AccessibilityInfo.announceForAccessibility(summary);
    const t = target.current;
    if (t) {
      const node = findNodeHandle(t);
      if (node != null) { try { AccessibilityInfo.setAccessibilityFocus?.(node); } catch { /* best effort */ } }
      try { t.focus?.(); } catch { /* best effort */ }
    }
  }

  async function submit() {
    setError(null);
    const missing: FieldErrors = {
      current: current ? null : "Current password is required.",
      next: next ? null : "New password is required.",
      confirm: confirm ? null : "Confirmation is required.",
    };
    if (missing.current || missing.next || missing.confirm) {
      const first = missing.current ? currentRef : missing.next ? nextRef : confirmRef;
      fail(missing, "All fields are required.", first);
      return;
    }
    if (next.length < 8) {
      fail({ ...noErrors, next: "New password must be at least 8 characters." }, "New password must be at least 8 characters.", nextRef);
      return;
    }
    if (next !== confirm) {
      fail({ ...noErrors, confirm: "New password and confirmation do not match." }, "New password and confirmation do not match.", confirmRef);
      return;
    }
    if (next === current) {
      fail({ ...noErrors, next: "New password must be different from current password." }, "New password must be different from current password.", nextRef);
      return;
    }
    setFieldErrors(noErrors);
    try {
      const resp = await mut.mutateAsync({ data: { currentPassword: current, newPassword: next } });
      // login() resets token + user atomically and is the right call after a session rotation.
      await login(resp.user, resp.token);
      // Defensive: if server didn't echo flags, ensure local mustChange is false.
      await updateUser({ mustChangePassword: false });
      await setToken(resp.token);
      if (isMandatory) {
        router.replace("/enable-biometric" as any);
      } else {
        router.back();
      }
    } catch (e) {
      setError((e as Error).message || "Could not change password");
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!isMandatory && (
          <TouchableOpacity onPress={() => router.back()} style={styles.backRow}>
            <Feather name="chevron-left" size={20} color={colors.foreground} />
            <Text style={{ color: colors.foreground }}>Back</Text>
          </TouchableOpacity>
        )}

        <View style={styles.header}>
          <Feather name="lock" size={28} color={colors.primary} />
          <Text style={[styles.title, { color: colors.foreground }]}>
            {isMandatory ? "Set a new password" : "Change password"}
          </Text>
          {isMandatory && (
            <Text style={[styles.sub, { color: colors.mutedForeground }]}>
              Welcome{user?.firstName ? `, ${user.firstName}` : ""}. For security, please replace the temporary password before continuing.
            </Text>
          )}
          {isSelfService && !isMandatory && (
            <Text style={[styles.sub, { color: colors.mutedForeground }]}>
              Use a strong password — at least 8 characters.
            </Text>
          )}
        </View>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={{ color: colors.destructive, flex: 1, fontSize: 13 }}>{error}</Text>
          </View>
        )}

        <Field label="Current password" required invalid={!!fieldErrors.current} errorText={fieldErrors.current ?? undefined}>
          <TextInput
            ref={currentRef}
            value={current}
            onChangeText={(v) => { setCurrent(v); if (fieldErrors.current && v) setFieldErrors((e) => ({ ...e, current: null })); }}
            secureTextEntry={!show}
            placeholder={isMandatory ? "Last 4 digits of your SSN" : "Current password"}
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.foreground, borderColor: fieldErrors.current ? colors.destructive : colors.border, backgroundColor: colors.secondary }]}
            accessibilityLabel={`Current password, required${fieldErrors.current ? `, invalid, ${fieldErrors.current}` : ""}`}
          />
        </Field>
        <Field label="New password" required invalid={!!fieldErrors.next} errorText={fieldErrors.next ?? undefined}>
          <TextInput
            ref={nextRef}
            value={next}
            onChangeText={(v) => { setNext(v); if (fieldErrors.next && v) setFieldErrors((e) => ({ ...e, next: null })); }}
            secureTextEntry={!show}
            placeholder="At least 8 characters"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.foreground, borderColor: fieldErrors.next ? colors.destructive : colors.border, backgroundColor: colors.secondary }]}
            accessibilityLabel={`New password, required${fieldErrors.next ? `, invalid, ${fieldErrors.next}` : ""}`}
            accessibilityHint="At least 8 characters"
          />
        </Field>
        <Field label="Confirm new password" required invalid={!!fieldErrors.confirm} errorText={fieldErrors.confirm ?? undefined}>
          <TextInput
            ref={confirmRef}
            value={confirm}
            onChangeText={(v) => { setConfirm(v); if (fieldErrors.confirm && v) setFieldErrors((e) => ({ ...e, confirm: null })); }}
            secureTextEntry={!show}
            placeholder="Re-enter new password"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.foreground, borderColor: fieldErrors.confirm ? colors.destructive : colors.border, backgroundColor: colors.secondary }]}
            accessibilityLabel={`Confirm new password, required${fieldErrors.confirm ? `, invalid, ${fieldErrors.confirm}` : ""}`}
          />
        </Field>
        <TouchableOpacity onPress={() => setShow((s) => !s)} style={styles.toggleRow}>
          <Feather name={show ? "eye-off" : "eye"} size={14} color={colors.mutedForeground} />
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{show ? "Hide" : "Show"} passwords</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={submit}
          disabled={mut.isPending}
          style={[styles.button, { backgroundColor: colors.primary, opacity: mut.isPending ? 0.7 : 1 }]}
        >
          {mut.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
              {isMandatory ? "Continue" : "Update password"}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, required, invalid, errorText, children }: { label: string; required?: boolean; invalid?: boolean; errorText?: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: invalid ? colors.destructive : colors.mutedForeground }]}>
        {label}{required ? " *" : ""}
      </Text>
      {children}
      {invalid && errorText && (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.destructive, fontSize: 11 }}>
          {errorText}
        </Text>
      )}
    </View>
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
  label: { fontSize: 11, letterSpacing: 1, fontWeight: "700", textTransform: "uppercase" },
  input: { height: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, fontSize: 15 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  button: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 8 },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});
