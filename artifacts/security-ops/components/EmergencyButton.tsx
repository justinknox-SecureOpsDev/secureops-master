import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, StyleSheet, Linking, Platform, ActivityIndicator, View, Animated, Easing, AccessibilityInfo } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { triggerEmergency } from "@workspace/api-client-react";
import { confirmAction, notify } from "@/utils/confirm";
import { useLocationConsent } from "@/contexts/LocationConsentContext";

const HOLD_MS = 3000;

export default function EmergencyButton() {
  const { ensureLocationPermission } = useLocationConsent();
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const [remaining, setRemaining] = useState(3);
  const [screenReaderOn, setScreenReaderOn] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (!cancelled) setScreenReaderOn(on);
    }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", (on) => setScreenReaderOn(on));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  const fire = async () => {
    setBusy(true);
    AccessibilityInfo.announceForAccessibility("Sending emergency alert");
    let lat: number | undefined;
    let lng: number | undefined;
    try {
      // silent: a panic alert must never wait behind a consent dialog. Once the
      // officer has accepted the location disclosure and granted GPS (the normal
      // case, since clocking in asks first), the alert carries their position;
      // otherwise it still goes out immediately, just without coordinates.
      if (await ensureLocationPermission({ silent: true })) {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        lat = loc.coords.latitude;
        lng = loc.coords.longitude;
      }
    } catch { /* ignore */ }

    let callNumber = "911";
    try {
      const result = await triggerEmergency({ lat: lat as any, lng: lng as any });
      callNumber = (result as any).callNumber || "911";
      AccessibilityInfo.announceForAccessibility("Emergency alert sent. Admins have been notified.");
    } catch (e: any) {
      notify("Alert Failed", e?.message || "Could not send alert. Try calling directly.");
    }

    setBusy(false);

    const tryCall = async () => {
      const url = `tel:${callNumber}`;
      try {
        const can = await Linking.canOpenURL(url);
        if (can) await Linking.openURL(url);
        else notify("Call Manually", `Please dial ${callNumber} now.`);
      } catch {
        notify("Call Manually", `Please dial ${callNumber} now.`);
      }
    };

    if (Platform.OS === "web") {
      notify("Alert Sent", `Admins notified. Call ${callNumber} from a phone if you need emergency services.`);
    } else {
      const wantsCall = await confirmAction({
        title: "Alert Sent — Call Emergency Services?",
        message: `Admins have been notified. Dial ${callNumber} now?`,
        confirmText: `Call ${callNumber}`,
        cancelText: "Not now",
        destructive: true,
      });
      if (wantsCall) await tryCall();
    }
  };

  const startHold = () => {
    if (busy || holding) return;
    firedRef.current = false;
    setHolding(true);
    setRemaining(3);
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
    tickRef.current = setInterval(() => {
      setRemaining((r) => (r > 1 ? r - 1 : 1));
    }, 1000);
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      cleanupHold();
      fire();
    }, HOLD_MS);
  };

  const cleanupHold = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setHolding(false);
    Animated.timing(progress, { toValue: 0, duration: 200, useNativeDriver: false }).start();
  };

  const cancelHold = () => {
    if (firedRef.current) return;
    cleanupHold();
  };

  // Screen-reader users can't perform a 3-second press gesture reliably, so
  // when TalkBack/VoiceOver is active we bypass the hold entirely and use a
  // confirmation prompt instead. The button also exposes a custom "activate"
  // accessibility action so users can trigger it from the rotor/menu.
  const activateViaScreenReader = async () => {
    if (busy) return;
    const ok = await confirmAction({
      title: "Send emergency alert?",
      message: "This notifies admins immediately and offers to dial emergency services.",
      confirmText: "Send alert",
      cancelText: "Cancel",
      destructive: true,
    });
    if (ok) fire();
  };

  const fillWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <Pressable
      onPressIn={screenReaderOn ? undefined : startHold}
      onPressOut={screenReaderOn ? undefined : cancelHold}
      onPress={screenReaderOn ? activateViaScreenReader : undefined}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={busy ? "Sending emergency alert" : "Emergency alert"}
      accessibilityHint={
        screenReaderOn
          ? "Double tap to send an emergency alert to admins and start a call."
          : "Press and hold for three seconds to send an emergency alert to admins."
      }
      accessibilityState={{ busy, disabled: busy }}
      accessibilityActions={[{ name: "activate", label: "Send emergency alert" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "activate") activateViaScreenReader();
      }}
      style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
    >
      <Animated.View pointerEvents="none" style={[styles.fill, { width: fillWidth }]} />
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <View style={styles.row}>
          <Feather name="alert-octagon" size={22} color="#fff" />
          <Text style={styles.text}>
            {screenReaderOn
              ? "EMERGENCY — DOUBLE TAP"
              : holding ? `HOLD… ${remaining}` : "HOLD 3s FOR EMERGENCY"}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: "#dc2626",
    paddingVertical: 16, paddingHorizontal: 20,
    borderRadius: 14, marginHorizontal: 16, marginVertical: 12,
    shadowColor: "#dc2626", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 10, elevation: 6,
    alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  btnPressed: { backgroundColor: "#b91c1c" },
  fill: {
    position: "absolute", left: 0, top: 0, bottom: 0,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  text: { color: "#fff", fontWeight: "800", fontSize: 15, letterSpacing: 1.5 },
});
