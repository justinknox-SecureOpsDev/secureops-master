import React, { useState, useMemo } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Alert, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetTimeEntries, getGetTimeEntriesQueryKey, useApproveTimeEntry } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

const FILTERS = ["pending", "approved", "rejected"] as const;

export default function TimeApprovalScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();
  const [filter, setFilter] = useState<typeof FILTERS[number]>("pending");
  const [edits, setEdits] = useState<Record<string, string>>({});

  const { data: entries, isLoading, refetch } = useGetTimeEntries({}, {
    query: { queryKey: getGetTimeEntriesQueryKey({}) },
  });

  const approve = useApproveTimeEntry();

  const visible = useMemo(() => {
    return ((entries ?? []) as any[])
      .filter((e) => e.clockOutTime)
      .filter((e) => (e.approvalStatus || "pending") === filter)
      .sort((a, b) => new Date(b.clockInTime).getTime() - new Date(a.clockInTime).getTime());
  }, [entries, filter]);

  const handle = (id: string, decision: "approved" | "rejected", logged: string) => {
    const override = edits[id];
    const hours = override ? parseFloat(override) : parseFloat(logged);
    if (decision === "approved" && (!Number.isFinite(hours) || hours <= 0)) {
      Alert.alert("Invalid hours", "Enter a positive number of hours."); return;
    }
    approve.mutateAsync({
      id,
      data: { decision, hoursWorked: decision === "approved" ? hours : undefined },
    } as any).then(() => {
      queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey({}) });
      setEdits((e) => { const n = { ...e }; delete n[id]; return n; });
    }).catch((e: any) => Alert.alert("Failed", e?.response?.data?.message || e?.message || "Approval failed"));
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Time Approval</Text>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)}
            style={[styles.chip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}>
            <Text style={[styles.chipText, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="check-circle" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No {filter} time entries.</Text>
            </View>
          }
          refreshing={false}
          onRefresh={refetch}
          renderItem={({ item }: { item: any }) => {
            const logged = parseFloat(item.hoursWorked ?? "0").toFixed(2);
            const editVal = edits[item.id] ?? logged;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: colors.foreground }]}>{item.employeeName}</Text>
                    <Text style={[styles.sub, { color: colors.mutedForeground }]}>{item.shiftTitle} · {item.siteName ?? "—"}</Text>
                  </View>
                  <View style={[styles.lvBadge, { backgroundColor: colors.primary + "20", borderColor: colors.primary }]}>
                    <Text style={{ color: colors.primary, fontSize: 11, fontWeight: "700" }}>${parseFloat(item.payRate ?? "0").toFixed(2)}/h</Text>
                  </View>
                </View>

                <Text style={[styles.line, { color: colors.mutedForeground }]}>
                  {new Date(item.clockInTime).toLocaleString()} → {item.clockOutTime ? new Date(item.clockOutTime).toLocaleString() : "—"}
                </Text>

                {filter === "pending" ? (
                  <View style={[styles.editRow, { borderColor: colors.border }]}>
                    <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>Approve hours:</Text>
                    <TextInput
                      value={editVal}
                      onChangeText={(v) => setEdits((e) => ({ ...e, [item.id]: v }))}
                      keyboardType="decimal-pad"
                      style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                    />
                    <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>Logged {logged}h</Text>
                  </View>
                ) : (
                  <Text style={[styles.line, { color: filter === "approved" ? "#22c55e" : colors.destructive, fontWeight: "700" }]}>
                    {filter === "approved" ? `Approved · ${parseFloat(item.hoursWorked ?? "0").toFixed(2)}h` : "Rejected"}
                  </Text>
                )}

                {filter === "pending" && (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TouchableOpacity onPress={() => handle(item.id, "approved", logged)}
                      style={[styles.actBtn, { backgroundColor: "#22c55e" }]}
                      disabled={approve.isPending}>
                      <Feather name="check" size={14} color="#fff" />
                      <Text style={[styles.actText, { color: "#fff" }]}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handle(item.id, "rejected", logged)}
                      style={[styles.actBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.destructive }]}
                      disabled={approve.isPending}>
                      <Feather name="x" size={14} color={colors.destructive} />
                      <Text style={[styles.actText, { color: colors.destructive }]}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 14, fontWeight: "700" },
  sub: { fontSize: 12, marginTop: 2 },
  line: { fontSize: 12 },
  lvBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  editRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderRadius: 6, borderWidth: 1 },
  input: { width: 80, height: 36, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, fontSize: 14, textAlign: "center" },
  actBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderRadius: 8 },
  actText: { fontWeight: "700", fontSize: 13 },
});
