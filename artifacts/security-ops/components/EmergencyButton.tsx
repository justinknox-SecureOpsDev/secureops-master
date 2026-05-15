import React, { useState } from "react";
import { TouchableOpacity, Text, StyleSheet, Alert, Linking, Platform, ActivityIndicator, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import { triggerEmergency } from "@workspace/api-client-react";

export default function EmergencyButton() {
  const [busy, setBusy] = useState(false);

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
      Alert.alert("Alert Failed", e?.message || "Could not send alert. Try calling directly.");
    }

    setBusy(false);

    const tryCall = async () => {
      const url = `tel:${callNumber}`;
      try {
        const can = await Linking.canOpenURL(url);
        if (can) await Linking.openURL(url);
        else Alert.alert("Call Manually", `Please dial ${callNumber} now.`);
      } catch {
        Alert.alert("Call Manually", `Please dial ${callNumber} now.`);
      }
    };

    if (Platform.OS === "web") {
      Alert.alert(
        "Alert Sent",
        `Admins notified. Call ${callNumber} from a phone if you need emergency services.`,
      );
    } else {
      Alert.alert(
        "Alert Sent — Call Emergency Services?",
        `Admins have been notified. Dial ${callNumber} now?`,
        [
          { text: "Not now", style: "cancel" },
          { text: `Call ${callNumber}`, style: "destructive", onPress: tryCall },
        ],
      );
    }
  };

  const handlePress = () => {
    Alert.alert(
      "🚨 Emergency Alert",
      "This will notify all admins immediately and offer to dial emergency services. Use only in a real emergency.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Send Alert", style: "destructive", onPress: fire },
      ],
    );
  };

  return (
    <TouchableOpacity onPress={handlePress} disabled={busy} style={styles.btn} activeOpacity={0.85}>
      {busy ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <View style={styles.row}>
          <Feather name="alert-octagon" size={22} color="#fff" />
          <Text style={styles.text}>EMERGENCY</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: "#dc2626",
    paddingVertical: 16, paddingHorizontal: 20,
    borderRadius: 14, marginHorizontal: 16, marginVertical: 12,
    shadowColor: "#dc2626", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 10, elevation: 6,
    alignItems: "center", justifyContent: "center",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  text: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: 2 },
});
