import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/contexts/AuthContext";

const DEMO_EMAIL = "guest@secureops.com";

export function DemoBanner() {
  const { user } = useAuth();
  if (user?.email !== DEMO_EMAIL) return null;

  return (
    <View style={styles.banner}>
      <Feather name="play-circle" size={13} color="#0c0a08" />
      <Text style={styles.text}>
        Demo Mode — explore freely, no real data is shown
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: "#c9a04a",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    color: "#0c0a08",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
