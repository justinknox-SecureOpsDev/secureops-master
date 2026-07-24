import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useFeatures, isEnabled, type FeatureKey } from "@/hooks/useFeatures";

type Item = {
  label: string;
  icon: string;
  route: string;
  desc: string;
  flag?: FeatureKey;
};

type Section = { title: string; items: readonly Item[] };

const SECTIONS: readonly Section[] = [
  {
    title: "OPERATIONS",
    items: [
      { label: "Personnel", icon: "users", route: "/(admin)/employees", desc: "Manage officers and staff accounts" },
      { label: "Shifts", icon: "calendar", route: "/(admin)/shifts", desc: "Schedule and manage site shifts" },
      { label: "Live Map", icon: "map", route: "/(admin)/live-map", desc: "Track on-duty officers in real time", flag: "liveMap" },
      { label: "Radio", icon: "radio", route: "/(admin)/radio", desc: "Push-to-talk team channels", flag: "radio" },
    ],
  },
  {
    title: "APPROVALS",
    items: [
      { label: "Shift Approvals", icon: "user-check", route: "/(admin)/shift-approvals", desc: "Review pending shift claim requests" },
      { label: "Time Approval", icon: "check-square", route: "/(admin)/time-approval", desc: "Approve submitted time entries" },
      { label: "Licence Approvals", icon: "award", route: "/(admin)/license-approvals", desc: "Review submitted licence documents" },
    ],
  },
  {
    title: "FINANCE & RECORDS",
    items: [
      { label: "Payroll", icon: "dollar-sign", route: "/(admin)/payroll", desc: "Review pay periods and earnings" },
      { label: "Invoices", icon: "file-text", route: "/(admin)/invoices", desc: "Client invoices and billing" },
      { label: "Clients", icon: "briefcase", route: "/(admin)/clients", desc: "Client accounts and their sites" },
      { label: "Licences", icon: "shield", route: "/(admin)/licenses", desc: "Officer licence levels and expiry" },
    ],
  },
] as const;

export default function AdminMoreScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const flags = useFeatures();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: 100 }}
    >
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">
          Management
        </Text>
      </View>
      {SECTIONS.map(({ title, items }) => {
        const visible = items.filter((item) => !item.flag || isEnabled(flags, item.flag));
        if (visible.length === 0) return null;
        return (
          <View key={title} style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.accent }]}>{title}</Text>
            {visible.map(({ label, icon, route, desc }) => (
              <TouchableOpacity
                key={label}
                style={[styles.item, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => router.push(route as any)}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={desc}
              >
                <View style={[styles.iconBox, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "40" }]}>
                  <Feather name={icon as any} size={22} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
                  <Text style={[styles.itemDesc, { color: colors.mutedForeground }]}>{desc}</Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  section: { paddingHorizontal: 16, paddingTop: 20, gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  itemLabel: { fontSize: 15, fontWeight: "700" },
  itemDesc: { fontSize: 12, marginTop: 2 },
});
