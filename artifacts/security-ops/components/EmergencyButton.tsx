import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, StyleSheet, Linking, Platform, ActivityIndicator, View, Animated, Easing } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { triggerEmergency } from "@workspace/api-client-react";
import { confirmAction, notify } from "@/utils/confirm";

const HOLD_MS = 3000;

export default function EmergencyButton() {
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const [remaining, setRemaining] = useState(3);
  const progress = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef(false);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  const fire = async () => {
    setBusy(true);
    let lat: number | undefined;
    let lng: number | undefined;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === "granted") {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        lat = loc.coords.latitude;
        lng = loc.coords.longitude;
      }
    } catch { /* ignore */ }

    let callNumber = "911";
    try {
      const result = await triggerEmergency({ lat: lat as any, lng: lng as any });
      callNumber = (result as any).callNumber || "911";
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

  const fillWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <Pressable
      onPressIn={startHold}
      onPressOut={cancelHold}
      disabled={busy}
      style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
    >
      <Animated.View pointerEvents="none" style={[styles.fill, { width: fillWidth }]} />
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <View style={styles.row}>
          <Feather name="alert-octagon" size={22} color="#fff" />
          <Text style={styles.text}>{holding ? `HOLD… ${remaining}` : "HOLD 3s FOR EMERGENCY"}</Text>
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
