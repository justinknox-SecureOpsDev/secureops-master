import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Location from "expo-location";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { storage } from "@/utils/storage";
import { resolveLocationAccess } from "@/utils/locationConsent";

// Google Play's User Data policy requires a "Prominent Disclosure": before we
// collect location we must tell the user, IN THE APP (not just in the privacy
// policy), what we collect, what it is used for, and who it is shared with —
// and they must take an affirmative action to continue. Play rejected the app
// for going straight to the OS permission dialog from the Clock screen.
//
// This is deliberately ANDROID-ONLY. Apple has twice rejected this app under
// Guideline 5.1.1(iv) for putting a dismissable custom screen in front of an OS
// permission prompt, so iOS keeps its existing behaviour of prompting directly.
// See .agents/memory/appstore-permission-priming.md.
const CONSENT_KEY = "location.disclosureAccepted.v1";

type EnsureOptions = {
  /**
   * Never show UI. Returns true only when the user has already accepted the
   * disclosure AND the OS permission is already granted. Used by paths that
   * must not be blocked by a dialog (the emergency alert) or that run on a
   * timer with no user gesture behind them (the on-shift position ping).
   */
  silent?: boolean;
};

type LocationConsentValue = {
  ensureLocationPermission: (opts?: EnsureOptions) => Promise<boolean>;
};

const LocationConsentContext = createContext<LocationConsentValue | null>(null);

export function useLocationConsent(): LocationConsentValue {
  const ctx = useContext(LocationConsentContext);
  if (!ctx) throw new Error("useLocationConsent must be used inside <LocationConsentProvider>");
  return ctx;
}

export function LocationConsentProvider({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const [visible, setVisible] = useState(false);
  const resolverRef = useRef<((accepted: boolean) => void) | null>(null);

  const pendingRef = useRef<Promise<boolean> | null>(null);

  const askForConsent = useCallback(() => {
    // Two callers can race (the Clock screen reads location on mount while a
    // patrol scan fires). They must share ONE dialog and one answer — without
    // this, the second call overwrites resolverRef and the first caller's
    // promise never settles.
    if (pendingRef.current) return pendingRef.current;
    const pending = new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
    pendingRef.current = pending;
    setVisible(true);
    return pending;
  }, []);

  const settle = useCallback((accepted: boolean) => {
    setVisible(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    pendingRef.current = null;
    resolve?.(accepted);
  }, []);

  // If the provider unmounts while the dialog is up, settle as "declined" so no
  // caller is left awaiting a promise that can never resolve.
  useEffect(
    () => () => {
      const resolve = resolverRef.current;
      resolverRef.current = null;
      pendingRef.current = null;
      resolve?.(false);
    },
    [],
  );

  const ensureLocationPermission = useCallback(
    async ({ silent = false }: EnsureOptions = {}): Promise<boolean> => {
      try {
        return await resolveLocationAccess({
          platform: Platform.OS,
          silent,
          hasAccepted: async () => (await storage.get(CONSENT_KEY)) === "true",
          recordAccepted: () => storage.set(CONSENT_KEY, "true"),
          askForConsent,
          getCurrentStatus: async () => (await Location.getForegroundPermissionsAsync()).status,
          requestPermission: async () => (await Location.requestForegroundPermissionsAsync()).status,
        });
      } catch {
        return false;
      }
    },
    [askForConsent],
  );

  return (
    <LocationConsentContext.Provider value={{ ensureLocationPermission }}>
      {children}
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        // Android hardware back = decline. There is always a way out, but it
        // never silently proceeds to collection.
        onRequestClose={() => settle(false)}
      >
        <View style={styles.backdrop}>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.header}>
              <View style={[styles.iconCircle, { borderColor: colors.primary, backgroundColor: colors.primary + "15" }]}>
                <Feather name="map-pin" size={22} color={colors.primary} />
              </View>
              <Text style={[styles.title, { color: colors.foreground }]}>Location used for your shift</Text>
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={{ gap: 12 }}>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                SecureOps collects your device&apos;s precise location (GPS) so your employer can run
                your shift. Please read this before you continue.
              </Text>

              <Disclosure
                colors={colors}
                label="What we collect"
                value="Your precise GPS location, together with the time it was recorded."
              />
              <Disclosure
                colors={colors}
                label="When we collect it"
                value="When you open the Clock screen, when you clock in or out, when you scan a patrol checkpoint, when you send an emergency alert, and about once a minute while you are clocked in."
              />
              <Disclosure
                colors={colors}
                label="What it is used for"
                value="To confirm you are at your assigned site when you clock in, and to show dispatch where you are while you are on shift so they can respond if you need help."
              />
              <Disclosure
                colors={colors}
                label="Who it is shared with"
                value="Your employer's dispatch and administrator team. It is not sold or shared with advertisers."
              />
              <Disclosure
                colors={colors}
                label="When we do NOT collect it"
                value="Only while the app is open on your screen. SecureOps does not track your location in the background, when the app is closed, or when you are not using it."
              />

              <Text style={[styles.footnote, { color: colors.mutedForeground }]}>
                If you decline, you can still use the app — you will be asked to pick your site by hand
                when you clock in.
              </Text>
            </ScrollView>

            <TouchableOpacity
              onPress={() => settle(true)}
              accessibilityRole="button"
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>I agree, continue</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => settle(false)} accessibilityRole="button" style={styles.secondaryBtn}>
              <Text style={{ color: colors.mutedForeground, fontWeight: "600" }}>Not now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </LocationConsentContext.Provider>
  );
}

function Disclosure({
  colors,
  label,
  value,
}: {
  colors: ReturnType<typeof useColors>;
  label: string;
  value: string;
}) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.discLabel, { color: colors.foreground }]}>{label}</Text>
      <Text style={[styles.discValue, { color: colors.mutedForeground }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", padding: 20 },
  card: { borderRadius: 14, borderWidth: 1, padding: 20, maxHeight: "88%", gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconCircle: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 2 },
  title: { fontSize: 18, fontWeight: "700", flex: 1 },
  // flexShrink lets the body scroll inside the card's maxHeight on small
  // screens instead of pushing the two buttons off the bottom of the display.
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { fontSize: 14, lineHeight: 20 },
  discLabel: { fontSize: 13, fontWeight: "700" },
  discValue: { fontSize: 13, lineHeight: 19 },
  footnote: { fontSize: 12, lineHeight: 18, fontStyle: "italic" },
  primaryBtn: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  primaryText: { fontSize: 15, fontWeight: "700", letterSpacing: 0.5 },
  secondaryBtn: { paddingVertical: 10, alignItems: "center" },
});
