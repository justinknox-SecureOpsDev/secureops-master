import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import EmployeeShiftsScreen from "./shifts";
import EmployeeClockScreen from "./clock";

type Tab = "shifts" | "clock";

export default function MyWorkScreen() {
  const colors = useColors();
  const topPad = useTopPad();
  const [activeTab, setActiveTab] = useState<Tab>("shifts");

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={[
          styles.segmentWrapper,
          {
            paddingTop: topPad + 8,
            backgroundColor: colors.card,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View
          style={[styles.segmentBar, { backgroundColor: colors.secondary, borderColor: colors.border }]}
          accessibilityRole="tablist"
        >
          {(["shifts", "clock"] as Tab[]).map((t) => {
            const active = activeTab === t;
            const label = t === "shifts" ? "My Shifts" : "Clock In/Out";
            return (
              <TouchableOpacity
                key={t}
                style={[
                  styles.segment,
                  active && { backgroundColor: colors.card, borderColor: colors.border },
                ]}
                onPress={() => setActiveTab(t)}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: active ? colors.foreground : colors.mutedForeground },
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={{ flex: 1, display: activeTab === "shifts" ? "flex" : "none" }}>
        <EmployeeShiftsScreen hideTopPad />
      </View>
      <View style={{ flex: 1, display: activeTab === "clock" ? "flex" : "none" }}>
        <EmployeeClockScreen hideTopPad />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  segmentWrapper: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  segmentBar: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: 1,
    padding: 3,
    overflow: "hidden",
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  segmentText: {
    fontSize: 13,
    fontWeight: "600",
  },
});
