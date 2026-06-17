import React, { useLayoutEffect } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter, useNavigation } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import { ProtectionPackageView } from "@/components/ProtectionPackageView";

/**
 * Read-only officer entry point to a PPO-detail shift's protection package
 * (ops plan, principals, threats, itinerary). Regular officers have no
 * Schedule tab and their My Shifts cards are action-only, so this dedicated
 * screen — reachable from the "View Protection Ops Plan" button on an accepted
 * PPO shift — is how they reach the brief without exposing the admin shift
 * detail's assignment/edit controls.
 *
 * Shift title/client come in as route params (no extra fetch / authz surface);
 * ProtectionPackageView itself fetches the brief and the GET endpoint enforces
 * that only an officer with an ACCEPTED assignment may read it. On 403/error it
 * renders nothing, so this screen degrades to just the header.
 */
export default function OfficerOpsPlanScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const navigation = useNavigation();
  useLayoutEffect(() => { (navigation as any).setOptions?.({ headerShown: false }); }, [navigation]);

  const { id, title, client } = useLocalSearchParams<{ id: string; title?: string; client?: string }>();

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} numberOfLines={1} accessibilityRole="header">
          {title || "Protection Detail"}
        </Text>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.heroRow}>
          <Feather name="shield" size={18} color={colors.accent} />
          <Text style={[styles.heroTitle, { color: colors.accent }]}>Protection Ops Plan</Text>
        </View>
        {!!client && (
          <View style={styles.heroRow}>
            <Feather name="briefcase" size={14} color={colors.mutedForeground} />
            <Text style={[styles.heroSub, { color: colors.foreground }]}>{client}</Text>
          </View>
        )}
        <Text style={[styles.heroNote, { color: colors.mutedForeground }]}>
          Confidential detail brief. Do not share outside the assigned team.
        </Text>
      </View>

      {!!id && <ProtectionPackageView shiftId={id} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { flex: 1, fontSize: 16, fontWeight: "700" },
  heroCard: { margin: 16, marginBottom: 4, padding: 18, borderRadius: 14, borderWidth: 1, gap: 8 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heroTitle: { fontSize: 16, fontWeight: "700" },
  heroSub: { fontSize: 14, fontWeight: "600", flex: 1 },
  heroNote: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
