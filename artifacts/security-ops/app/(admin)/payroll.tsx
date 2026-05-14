import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetPayroll, getGetPayrollQueryKey, useProcessPayroll } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_FILTERS = ["pending", "processed", "paid"] as const;

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const map: Record<string, string> = { pending: colors.accent, processed: colors.primary, paid: "#22c55e" };
  const c = map[status] || colors.mutedForeground;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

export default function AdminPayrollScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("pending");
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: payroll, isLoading, error, refetch } = useGetPayroll({
    params: { status: filter },
    query: { queryKey: getGetPayrollQueryKey({ status: filter }) }
  });

  const processMutation = useProcessPayroll();

  const handleProcess = (id: string, name: string, amount: string) => {
    Alert.alert("Process Payroll", `Process $${amount} payment for ${name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Process", onPress: async () => {
          await processMutation.mutateAsync({ id, data: { status: "processed" } });
          queryClient.invalidateQueries({ queryKey: getGetPayrollQueryKey() });
        }
      }
    ]);
  };

  const totalAmount = (payroll ?? [])
    .filter((p) => p.status === "pending")
    .reduce((sum, p) => sum + parseFloat(p.grossAmount as any), 0);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Payroll</Text>
      </View>

      {filter === "pending" && (payroll?.length ?? 0) > 0 && (
        <View style={[styles.summaryBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View>
            <Text style={[styles.sumLabel, { color: colors.mutedForeground }]}>PENDING TOTAL</Text>
            <Text style={[styles.sumAmount, { color: colors.primary }]}>${totalAmount.toFixed(2)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.bulkBtn, { backgroundColor: colors.primary }]}
            onPress={() => Alert.alert("Bulk Process", "Process all pending payroll entries?", [
              { text: "Cancel", style: "cancel" },
              { text: "Process All", onPress: async () => {
                for (const p of (payroll ?? []).filter((x) => x.status === "pending")) {
                  await processMutation.mutateAsync({ id: p.id, data: { status: "processed" } });
                }
                queryClient.invalidateQueries({ queryKey: getGetPayrollQueryKey() });
              }}
            ])}
          >
            <Feather name="check-square" size={16} color={colors.primaryForeground} />
            <Text style={[styles.bulkBtnText, { color: colors.primaryForeground }]}>Process All</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load payroll</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]}>
            <Text style={{ color: colors.primary }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={payroll ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(payroll && payroll.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="dollar-sign" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No {filter} payroll entries</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={[styles.empName, { color: colors.foreground }]}>{item.employeeName}</Text>
                  <Text style={[styles.period, { color: colors.mutedForeground }]}>
                    {new Date(item.periodStart).toLocaleDateString()} – {new Date(item.periodEnd).toLocaleDateString()}
                  </Text>
                </View>
                <StatusBadge status={item.status} />
              </View>

              <View style={[styles.rateGrid, { borderTopColor: colors.border }]}>
                <View style={styles.rateItem}>
                  <Text style={[styles.rateVal, { color: colors.foreground }]}>{parseFloat(item.hoursWorked as any).toFixed(1)}h</Text>
                  <Text style={[styles.rateLbl, { color: colors.mutedForeground }]}>Hours</Text>
                </View>
                <View style={[styles.rateDivider, { backgroundColor: colors.border }]} />
                <View style={styles.rateItem}>
                  <Text style={[styles.rateVal, { color: colors.foreground }]}>${parseFloat(item.hourlyRate as any).toFixed(2)}</Text>
                  <Text style={[styles.rateLbl, { color: colors.mutedForeground }]}>Rate/hr</Text>
                </View>
                <View style={[styles.rateDivider, { backgroundColor: colors.border }]} />
                <View style={styles.rateItem}>
                  <Text style={[styles.rateVal, { color: colors.primary }]}>${parseFloat(item.grossAmount as any).toFixed(2)}</Text>
                  <Text style={[styles.rateLbl, { color: colors.mutedForeground }]}>Gross</Text>
                </View>
              </View>

              {item.status === "pending" && (
                <TouchableOpacity
                  style={[styles.processBtn, { borderColor: colors.primary }]}
                  onPress={() => handleProcess(item.id, item.employeeName || "", parseFloat(item.grossAmount as any).toFixed(2))}
                  disabled={processMutation.isPending}
                >
                  <Feather name="check-circle" size={16} color={colors.primary} />
                  <Text style={[styles.processBtnText, { color: colors.primary }]}>Mark Processed</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  summaryBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", margin: 16, marginBottom: 4, padding: 16, borderRadius: 12, borderWidth: 1 },
  sumLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  sumAmount: { fontSize: 26, fontWeight: "800", marginTop: 4 },
  bulkBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  bulkBtnText: { fontWeight: "700", fontSize: 13 },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  empName: { fontSize: 15, fontWeight: "700" },
  period: { fontSize: 12, marginTop: 2 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  rateGrid: { flexDirection: "row", paddingTop: 12, borderTopWidth: 1 },
  rateItem: { flex: 1, alignItems: "center" },
  rateVal: { fontSize: 18, fontWeight: "700" },
  rateLbl: { fontSize: 11, marginTop: 2 },
  rateDivider: { width: 1, marginVertical: 4 },
  processBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  processBtnText: { fontWeight: "700", fontSize: 14 },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
});
