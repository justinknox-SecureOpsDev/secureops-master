import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetInvoices, getGetInvoicesQueryKey, useUpdateInvoiceStatus } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_FILTERS = ["draft", "sent", "paid", "overdue"] as const;

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const map: Record<string, string> = { draft: colors.mutedForeground, sent: colors.primary, paid: "#22c55e", overdue: colors.destructive };
  const c = map[status] || colors.mutedForeground;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

export default function AdminInvoicesScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("sent");
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: invoices, isLoading, error, refetch } = useGetInvoices({
    params: { status: filter },
    query: { queryKey: getGetInvoicesQueryKey({ status: filter }) }
  });

  const updateStatus = useUpdateInvoiceStatus();

  const handleMarkPaid = (id: string, invoiceNumber: string) => {
    Alert.alert("Mark as Paid", `Mark Invoice ${invoiceNumber} as paid?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Mark Paid", onPress: async () => {
          await updateStatus.mutateAsync({ id, data: { status: "paid", paidAt: new Date().toISOString() } });
          queryClient.invalidateQueries({ queryKey: getGetInvoicesQueryKey() });
        }
      }
    ]);
  };

  const handleSend = (id: string, invoiceNumber: string) => {
    Alert.alert("Send Invoice", `Mark ${invoiceNumber} as sent to client?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Send", onPress: async () => {
          await updateStatus.mutateAsync({ id, data: { status: "sent" } });
          queryClient.invalidateQueries({ queryKey: getGetInvoicesQueryKey() });
        }
      }
    ]);
  };

  const totalOutstanding = (invoices ?? [])
    .filter((i) => i.status === "sent" || i.status === "overdue")
    .reduce((sum, i) => sum + parseFloat(i.totalAmount as any), 0);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Invoices</Text>
      </View>

      {(filter === "sent" || filter === "overdue") && (invoices?.length ?? 0) > 0 && (
        <View style={[styles.summaryBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="dollar-sign" size={22} color={colors.accent} />
          <View>
            <Text style={[styles.sumLabel, { color: colors.mutedForeground }]}>OUTSTANDING</Text>
            <Text style={[styles.sumAmount, { color: colors.accent }]}>${totalOutstanding.toFixed(2)}</Text>
          </View>
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
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load invoices</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]}><Text style={{ color: colors.primary }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={invoices ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(invoices && invoices.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="file-text" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No {filter} invoices</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: item.status === "overdue" ? colors.destructive + "50" : colors.border }]}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.invoiceNum, { color: colors.foreground }]}>{item.invoiceNumber}</Text>
                  <Text style={[styles.clientName, { color: colors.primary }]}>{item.clientName}</Text>
                </View>
                <StatusBadge status={item.status} />
              </View>

              <View style={[styles.amountRow, { borderTopColor: colors.border, borderBottomColor: colors.border }]}>
                <View style={styles.amtItem}>
                  <Text style={[styles.amtVal, { color: colors.foreground }]}>${parseFloat(item.subtotal as any).toFixed(2)}</Text>
                  <Text style={[styles.amtLbl, { color: colors.mutedForeground }]}>Subtotal</Text>
                </View>
                <View style={[styles.amtDivider, { backgroundColor: colors.border }]} />
                <View style={styles.amtItem}>
                  <Text style={[styles.amtVal, { color: colors.mutedForeground }]}>${parseFloat(item.taxAmount as any).toFixed(2)}</Text>
                  <Text style={[styles.amtLbl, { color: colors.mutedForeground }]}>GST</Text>
                </View>
                <View style={[styles.amtDivider, { backgroundColor: colors.border }]} />
                <View style={styles.amtItem}>
                  <Text style={[styles.amtVal, { color: colors.accent }]}>${parseFloat(item.totalAmount as any).toFixed(2)}</Text>
                  <Text style={[styles.amtLbl, { color: colors.mutedForeground }]}>Total</Text>
                </View>
              </View>

              <View style={styles.dateRow}>
                <Feather name="calendar" size={13} color={colors.mutedForeground} />
                <Text style={[styles.dateText, { color: colors.mutedForeground }]}>
                  Issued: {new Date(item.issuedAt).toLocaleDateString()}
                </Text>
                <Feather name="clock" size={13} color={item.status === "overdue" ? colors.destructive : colors.mutedForeground} style={{ marginLeft: 8 }} />
                <Text style={[styles.dateText, { color: item.status === "overdue" ? colors.destructive : colors.mutedForeground }]}>
                  Due: {new Date(item.dueAt).toLocaleDateString()}
                </Text>
              </View>

              <View style={styles.actionRow}>
                {item.status === "draft" && (
                  <TouchableOpacity style={[styles.actionBtn, { borderColor: colors.primary }]} onPress={() => handleSend(item.id, item.invoiceNumber)}>
                    <Feather name="send" size={14} color={colors.primary} />
                    <Text style={[styles.actionText, { color: colors.primary }]}>Mark Sent</Text>
                  </TouchableOpacity>
                )}
                {(item.status === "sent" || item.status === "overdue") && (
                  <TouchableOpacity style={[styles.actionBtn, { borderColor: "#22c55e" }]} onPress={() => handleMarkPaid(item.id, item.invoiceNumber)}>
                    <Feather name="check-circle" size={14} color="#22c55e" />
                    <Text style={[styles.actionText, { color: "#22c55e" }]}>Mark Paid</Text>
                  </TouchableOpacity>
                )}
              </View>
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
  summaryBar: { flexDirection: "row", alignItems: "center", gap: 12, margin: 16, marginBottom: 4, padding: 16, borderRadius: 12, borderWidth: 1 },
  sumLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  sumAmount: { fontSize: 26, fontWeight: "800", marginTop: 2 },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8, flexWrap: "wrap" },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  invoiceNum: { fontSize: 16, fontWeight: "700" },
  clientName: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  amountRow: { flexDirection: "row", paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1 },
  amtItem: { flex: 1, alignItems: "center" },
  amtVal: { fontSize: 17, fontWeight: "700" },
  amtLbl: { fontSize: 11, marginTop: 2 },
  amtDivider: { width: 1, marginVertical: 4 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  dateText: { fontSize: 12 },
  actionRow: { flexDirection: "row", gap: 8 },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  actionText: { fontWeight: "700", fontSize: 13 },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
});
