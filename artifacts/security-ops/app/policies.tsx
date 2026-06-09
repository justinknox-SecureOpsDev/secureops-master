import React, { useCallback, useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Linking, Alert,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useListActivePolicies } from "@workspace/api-client-react";
import type { PolicyPublic } from "@workspace/api-client-react";

export default function PoliciesScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const [opening, setOpening] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isRefetching } = useListActivePolicies();
  const policies = (data ?? []) as PolicyPublic[];

  const openPolicy = useCallback(async (p: PolicyPublic) => {
    if (!p.viewUrl) {
      Alert.alert("Unavailable", "This policy has no document attached yet.");
      return;
    }
    try {
      setOpening(p.id);
      const can = await Linking.canOpenURL(p.viewUrl);
      if (can) {
        await Linking.openURL(p.viewUrl);
      } else {
        Alert.alert("Cannot open", "No app available to open this document.");
      }
    } catch {
      Alert.alert("Error", "Could not open the policy document.");
    } finally {
      setOpening(null);
    }
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={[styles.container, { backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.primary} />
        }
      >
        <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="chevron-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">
            Policies & Procedures
          </Text>
          <View style={{ width: 32 }} />
        </View>

        {isLoading ? (
          <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
        ) : isError ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.destructive, fontSize: 14 }}>
              Could not load policies. Pull down to retry.
            </Text>
          </View>
        ) : policies.length === 0 ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, alignItems: "center" }]}>
            <Feather name="book-open" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No policies published</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Active company policies and procedures will appear here once published.
            </Text>
          </View>
        ) : (
          <View style={{ padding: 16, gap: 10 }}>
            {policies.map((p) => {
              const busy = opening === p.id;
              const hasDoc = !!p.viewUrl;
              return (
                <TouchableOpacity
                  key={p.id}
                  onPress={() => void openPolicy(p)}
                  disabled={busy || !hasDoc}
                  style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border, opacity: hasDoc ? 1 : 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open policy ${p.label}`}
                  accessibilityHint={hasDoc ? "Opens the policy document" : "No document attached"}
                >
                  <Feather name="file-text" size={20} color={colors.accent} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: colors.foreground }]}>{p.label}</Text>
                    <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                      {p.fileName ?? "No document"} · v{p.version}
                    </Text>
                  </View>
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Feather name={hasDoc ? "chevron-right" : "slash"} size={16} color={colors.mutedForeground} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, justifyContent: "space-between" },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  section: { margin: 16, padding: 18, borderRadius: 12, borderWidth: 1, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", marginTop: 12 },
  emptyText: { fontSize: 13, textAlign: "center", marginTop: 4, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 12, borderWidth: 1 },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  rowMeta: { fontSize: 12, marginTop: 2 },
});
