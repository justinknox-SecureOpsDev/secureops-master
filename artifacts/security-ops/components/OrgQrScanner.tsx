import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Linking,
} from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { extractOrgCodeFromDeepLink } from "@/utils/orgConfig";

/**
 * Full-screen QR-code scanner for organization onboarding.
 *
 * Staff scan an invite QR code (which encodes a `?code=<org>` deep link) instead
 * of typing the org code on /connect. The first valid scan is lifted up via
 * `onScanned(code)`; the connect screen then resolves + persists it exactly like
 * a typed code. Code entry remains the fallback (this is opened on demand).
 *
 * Native only — barcode scanning via the device camera isn't reliably available
 * on web, so the connect screen hides the launcher there.
 */
export function OrgQrScanner({
  onScanned,
  onClose,
}: {
  onScanned: (code: string) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  // Guard against the camera firing multiple barcode callbacks for one frame.
  const [handled, setHandled] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // App Store Guideline 5.1.1(iv): no custom pre-permission screen the user can
  // dismiss — go straight to the OS permission prompt as soon as the scanner
  // opens. The explanatory screen below is only shown AFTER a denial.
  const requested = useRef(false);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && !requested.current) {
      requested.current = true;
      requestPermission().finally(() => setAnswered(true));
    }
  }, [permission, requestPermission]);

  const handleScan = (result: BarcodeScanningResult) => {
    if (handled) return;
    const code = extractOrgCodeFromDeepLink(result.data ?? "");
    if (!code) {
      setNotFound(true);
      return;
    }
    setHandled(true);
    onScanned(code);
  };

  const Frame = ({ children }: { children: React.ReactNode }) => (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
        >
          <Feather name="x" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>SCAN INVITE QR</Text>
        <View style={styles.closeBtn} />
      </View>
      {children}
    </View>
  );

  // Permission state loading, or the OS prompt is up (auto-requested on open):
  // show only a spinner — never a custom message ahead of the system prompt.
  // (Android can leave canAskAgain=true after a first denial, so also gate on
  // whether our auto-request has been answered.)
  if (!permission || (!permission.granted && permission.canAskAgain && !answered)) {
    return (
      <Frame>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </Frame>
    );
  }

  if (!permission.granted) {
    // Post-denial guidance only (the user already answered the OS prompt).
    return (
      <Frame>
        <View style={styles.center}>
          <Feather name="camera-off" size={40} color={colors.mutedForeground} />
          <Text style={[styles.permTitle, { color: colors.foreground }]}>
            Camera access is off
          </Text>
          <Text style={[styles.permSub, { color: colors.mutedForeground }]}>
            To scan your organization's invite QR code, turn on camera access in
            Settings — or go back and enter the code manually.
          </Text>
          {Platform.OS !== "web" ? (
            <TouchableOpacity
              style={[styles.button, { backgroundColor: colors.primary }]}
              onPress={() => Linking.openSettings()}
              accessibilityRole="button"
              accessibilityLabel="Open Settings"
            >
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                Open Settings
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={onClose} style={styles.linkBtn}>
            <Text style={{ color: colors.primary, fontWeight: "600" }}>
              Enter code manually
            </Text>
          </TouchableOpacity>
        </View>
      </Frame>
    );
  }

  return (
    <Frame>
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={handled ? undefined : handleScan}
        />
        <View style={styles.overlay} pointerEvents="none">
          <View style={[styles.reticle, { borderColor: colors.primary }]} />
          <Text style={styles.hint}>
            {notFound
              ? "That QR code doesn't contain an organization code."
              : "Point your camera at the invite QR code"}
          </Text>
        </View>
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, ...(Platform.OS === "web" ? { minHeight: 400 } : null) },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
  },
  closeBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 14, fontWeight: "800", letterSpacing: 3 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  permTitle: { fontSize: 18, fontWeight: "700", marginTop: 6 },
  permSub: { fontSize: 13, lineHeight: 19, textAlign: "center", maxWidth: 300 },
  button: {
    height: 48,
    paddingHorizontal: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  buttonText: { fontWeight: "800", fontSize: 14, letterSpacing: 2 },
  linkBtn: { padding: 10 },
  cameraWrap: { flex: 1, overflow: "hidden", position: "relative" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 24 },
  reticle: { width: 240, height: 240, borderWidth: 3, borderRadius: 24 },
  hint: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 24,
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowRadius: 6,
  },
});
