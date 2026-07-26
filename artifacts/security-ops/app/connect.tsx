import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Platform, Modal, Alert,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { SecureOpsLogo } from "@/components/SecureOpsLogo";
import { OrgQrScanner } from "@/components/OrgQrScanner";
import { useOrg } from "@/contexts/OrgContext";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeOrgCode, isValidOrgCode, decideOrgCodeAction, resolveOrgCode } from "@/utils/orgConfig";
import { runConnectOrgFlow, runSwitchToCodeFlow } from "@/utils/orgBootstrap";

/**
 * Pre-login organization connect screen (native only).
 *
 * ONE app-store build serves many customers; this screen asks for the short
 * organization code, resolves it to that customer's backend via the central
 * directory, and persists the choice before routing on to sign-in.
 */
export default function ConnectScreen() {
  const params = useLocalSearchParams<{ code?: string | string[] }>();
  const colors = useColors();
  const router = useRouter();
  const { org, selectOrg, switchOrg } = useOrg();
  const { user } = useAuth();

  // A `?code=` deep-link / QR param prefills the field so the user doesn't type.
  const prefilled = Array.isArray(params.code) ? params.code[0] : params.code;
  const [code, setCode] = useState(prefilled ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // First-run connect (no org selected yet): resolve + apply the code, then go
  // to sign-in. The flow validates the code and surfaces errors inline.
  const runFirstConnect = useCallback(
    async (rawCode: string) => {
      await runConnectOrgFlow(rawCode, {
        selectOrg,
        navigateToLogin: () => router.replace("/login"),
        setBusy,
        setError,
      });
    },
    [router, selectOrg],
  );

  // Clean switch to a DIFFERENT org while already connected: tear down the
  // current org (logout + session/cache/route reset) FIRST, then resolve +
  // apply the new code, then route to sign-in.
  const runSwitch = useCallback(
    async (incoming: string) => {
      await runSwitchToCodeFlow(incoming, {
        switchOrg,
        selectOrg,
        navigateToLogin: () => router.replace("/login"),
        setBusy,
        setError,
      });
    },
    [router, selectOrg, switchOrg],
  );

  // Route back to wherever the user belongs when there's nothing to connect
  // (e.g. they tapped an invite for the org they're already on, or cancelled a
  // switch). A signed-in user lands on their role home; otherwise sign-in.
  const goToLanding = useCallback(() => {
    if (!user) {
      router.replace("/login");
    } else if (user.role === "admin") {
      router.replace("/(admin)/dashboard" as any);
    } else {
      router.replace("/(employee)/home" as any);
    }
  }, [user, router]);

  // Web connect. The web build always talks to its OWN same origin (see
  // utils/api getApiBaseUrl), so we never re-point the API origin in place —
  // that would leave the hand-written fetch helper same-origin while the
  // generated client goes cross-origin and trips CORS. Instead we resolve the
  // code to its backend origin and HARD-NAVIGATE the browser there, where the
  // app is same-origin again. When the resolved org IS this very deployment
  // (the common case on the platform/demo host) we skip the reload and go
  // straight to sign-in. `busy` is intentionally left set on success — we're
  // leaving this page.
  const runWebConnect = useCallback(
    async (rawCode: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const resolved = await resolveOrgCode(rawCode);
        const target = resolved.apiBaseUrl.replace(/\/+$/, "");
        if (typeof window !== "undefined" && target === window.location.origin) {
          router.replace("/login");
          return;
        }
        if (typeof window !== "undefined") {
          window.location.assign(`${target}/app/`);
          return;
        }
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Couldn't connect to that organization. Try again.",
        );
        setBusy(false);
      }
    },
    [busy, router],
  );

  // THE single safe entry point for every code that arrives here — invite-link
  // / QR deep link, the QR scanner, the Connect button, and the keyboard
  // submit. It decides what to do and, crucially, NEVER re-points the backend
  // for an already-connected device without first running the teardown-first
  // switch flow. `onDismiss` handles the "nothing to do / cancelled" outcome.
  const connectOrSwitch = useCallback(
    (rawCode: string, onDismiss: () => void) => {
      if (busy) return;
      if (Platform.OS === "web") {
        // Web has no persisted org and no in-place origin switch (see
        // runWebConnect): resolve the code and navigate to that org's web app.
        // `onDismiss` is unused here — there's no same-org teardown to undo.
        void runWebConnect(rawCode);
        return;
      }
      const action = decideOrgCodeAction(rawCode, org?.code ?? null);
      switch (action.kind) {
        case "connect":
          // No org yet → ordinary first-run connect (no session to tear down).
          void runFirstConnect(action.code);
          return;
        case "invalid":
          // Already connected + junk / crafted code → NEVER tear down the live
          // session; just surface the error and stay put.
          setError("Enter a valid organization code.");
          return;
        case "same":
          // Already on this org → nothing to switch.
          onDismiss();
          return;
        case "switch": {
          // Different org → always go through the teardown-first switch flow.
          // When a session is live, confirm first so the sign-out is never
          // silent; otherwise switch straight away.
          const doSwitch = () => void runSwitch(action.code);
          if (user) {
            Alert.alert(
              "Switch organization?",
              `You're connected to ${org!.name}. Switching to "${action.code}" will sign you out and connect this device to that organization.`,
              [
                { text: "Cancel", style: "cancel", onPress: onDismiss },
                { text: "Switch", style: "destructive", onPress: doSwitch },
              ],
            );
            return;
          }
          doSwitch();
          return;
        }
      }
    },
    [busy, org, user, runFirstConnect, runSwitch, runWebConnect],
  );

  // Auto-act on a valid prefilled code exactly once. Invite-link taps and QR
  // scans land here with `?code=` already set: on first run this connects the
  // device in a single tap; while already connected it drives the switch
  // prompt. Invalid junk codes are ignored (left for manual entry). On the
  // already-connected "same org / cancelled" outcome we bounce to the landing
  // so a signed-in user is never stranded on /connect.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current) return;
    if (!prefilled) return;
    if (!isValidOrgCode(normalizeOrgCode(prefilled))) return;
    autoTried.current = true;
    connectOrSwitch(prefilled, goToLanding);
  }, [prefilled, connectOrSwitch, goToLanding]);

  // Manual Connect button / keyboard submit.
  const handleConnect = useCallback(
    (rawCode?: string) => {
      connectOrSwitch(rawCode ?? code, goToLanding);
    },
    [connectOrSwitch, code, goToLanding],
  );

  const handleScanned = useCallback(
    (scannedCode: string) => {
      setScanning(false);
      setCode(scannedCode);
      connectOrSwitch(scannedCode, goToLanding);
    },
    [connectOrSwitch, goToLanding],
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.glow} />

      <View style={styles.content}>
        <View
          style={styles.logoWrap}
          accessible
          accessibilityRole="image"
          accessibilityLabel="SecureOps Command"
        >
          <SecureOpsLogo size={120} />
        </View>

        <View style={styles.brandBlock}>
          <Text style={[styles.brandName, { color: colors.foreground }]}>SecureOps</Text>
          <Text style={[styles.brandSub, { color: colors.primary }]}>COMMAND</Text>
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.primary }]} />
            <Text style={[styles.motto, { color: colors.mutedForeground }]}>SECURITY OPERATIONS PLATFORM</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.primary }]} />
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>CONNECT YOUR ORGANIZATION</Text>
          <Text style={[styles.cardSubtitle, { color: colors.mutedForeground }]}>
            Enter the organization code provided by your employer to connect this
            device to your team. You'll sign in on the next screen.
          </Text>

          {error && (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + "25", borderColor: colors.destructive }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={{ color: colors.destructive, fontSize: 13, flex: 1 }}>{error}</Text>
            </View>
          )}

          <View style={[styles.inputWrap, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
            <Feather name="briefcase" size={16} color={colors.mutedForeground} />
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="Organization code"
              placeholderTextColor={colors.mutedForeground}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="go"
              onSubmitEditing={() => handleConnect()}
              accessibilityLabel="Organization code"
              accessibilityHint="Enter the code provided by your employer"
            />
          </View>

          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary, opacity: busy || !code.trim() ? 0.7 : 1 }]}
            onPress={() => handleConnect()}
            disabled={busy || !code.trim()}
            accessibilityRole="button"
            accessibilityLabel="Connect"
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <>
                <Feather name="link" size={16} color={colors.primaryForeground} />
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>CONNECT</Text>
              </>
            )}
          </TouchableOpacity>

          {Platform.OS !== "web" && (
            <>
              <View style={styles.orRow}>
                <View style={[styles.orLine, { backgroundColor: colors.border }]} />
                <Text style={[styles.orText, { color: colors.mutedForeground }]}>OR</Text>
                <View style={[styles.orLine, { backgroundColor: colors.border }]} />
              </View>

              <TouchableOpacity
                style={[styles.scanButton, { borderColor: colors.primary, opacity: busy ? 0.7 : 1 }]}
                onPress={() => setScanning(true)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Scan invite QR code"
                accessibilityHint="Opens the camera to scan your organization's invite QR code"
              >
                <Feather name="maximize" size={16} color={colors.primary} />
                <Text style={[styles.scanButtonText, { color: colors.primary }]}>SCAN INVITE QR</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <Text style={[styles.footer, { color: colors.mutedForeground }]}>
          SecureOps Command · © {new Date().getFullYear()}
        </Text>
      </View>

      <Modal
        visible={scanning}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScanning(false)}
      >
        <OrgQrScanner onScanned={handleScanned} onClose={() => setScanning(false)} />
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  glow: {
    position: "absolute",
    top: "20%",
    alignSelf: "center",
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "#c9a04a",
    opacity: 0.07,
    transform: [{ scaleX: 1.6 }],
  },
  content: { flex: 1, justifyContent: "center", padding: 24, gap: 20 },
  logoWrap: { alignItems: "center" },
  brandBlock: { alignItems: "center", gap: 4 },
  brandName: { fontSize: 24, fontWeight: "800", letterSpacing: 4 },
  brandSub: { fontSize: 15, fontWeight: "600", letterSpacing: 6 },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  dividerLine: { flex: 1, height: 1, opacity: 0.5 },
  motto: { fontSize: 9, letterSpacing: 2, fontWeight: "600" },
  card: { padding: 22, borderRadius: 14, borderWidth: 1, gap: 14 },
  cardTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 3, textAlign: "center", marginBottom: 4 },
  cardSubtitle: { fontSize: 11, lineHeight: 15, textAlign: "center", marginBottom: 4, paddingHorizontal: 4 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 10, height: 50, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14 },
  input: { flex: 1, fontSize: 15 },
  button: { height: 50, justifyContent: "center", alignItems: "center", borderRadius: 8, flexDirection: "row", gap: 10, marginTop: 4 },
  buttonText: { fontWeight: "800", fontSize: 14, letterSpacing: 2 },
  orRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  orLine: { flex: 1, height: 1 },
  orText: { fontSize: 10, fontWeight: "700", letterSpacing: 2 },
  scanButton: { height: 50, justifyContent: "center", alignItems: "center", borderRadius: 8, flexDirection: "row", gap: 10, borderWidth: 1 },
  scanButtonText: { fontWeight: "800", fontSize: 14, letterSpacing: 2 },
  footer: { textAlign: "center", fontSize: 11, letterSpacing: 1 },
});
