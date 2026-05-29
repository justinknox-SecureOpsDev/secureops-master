import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";

export function levelLabel(lvl: number | null | undefined): string {
  if (lvl == null) return "No Licence";
  if (lvl <= 1) return "Support";
  if (lvl === 4) return "L4 / PPO";
  return `Level ${lvl}`;
}

export function levelColor(lvl: number | null | undefined, colors: ReturnType<typeof useColors>): string {
  if (lvl == null) return colors.mutedForeground;
  if (lvl <= 1) return "#0ea5e9";
  if (lvl === 4) return "#a855f7";
  if (lvl === 3) return colors.accent;
  return "#22c55e";
}

export function LicenseLevelBadge({ level, size = "md" }: { level: number | null | undefined; size?: "sm" | "md" | "lg" }) {
  const colors = useColors();
  const c = levelColor(level, colors);
  const fs = size === "lg" ? 13 : size === "sm" ? 9 : 11;
  const px = size === "lg" ? 12 : size === "sm" ? 6 : 8;
  const py = size === "lg" ? 5 : size === "sm" ? 2 : 3;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c, paddingHorizontal: px, paddingVertical: py }]}>
      <Text style={{ color: c, fontSize: fs, fontWeight: "700", letterSpacing: 0.6 }}>{levelLabel(level).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 6, borderWidth: 1, alignSelf: "flex-start" },
});
