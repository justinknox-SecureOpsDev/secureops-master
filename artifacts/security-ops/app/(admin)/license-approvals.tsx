import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Alert, Platform, Modal, TextInput, Linking,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useGetAdminLicenseRenewals, getGetAdminLicenseRenewalsQueryKey,
  useApproveLicenseRenewal, useRejectLicenseRenewal,
} from "@workspace/api-client-react";
import type { LicenseRenewal } from "@workspace/api-client-react";
import { LicenseLevelBadge } from "@/components/LicenseLevelBadge";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/utils/api";

const STATUS_FILTERS = ["pending", "approved", "rejected", "all"] as const;

const STATUS_TONE: Record<string, string> = {
  pending: "#d4a72c",
  approved: "#22c55e",
  rejected: "#ef4444",
};

export default function LicenseApprovalsScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("pending");
  const [decision, setDecision] = useState<{ renewal: LicenseRenewal; action: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");

  const params = filter === "all" ? {} : { status: filter };
  const { data: renewals, isLoading, error, refetch } = useGetAdminLicenseRenewals(
    params as any,
    { query: { queryKey: getGetAdminLicenseRenewalsQueryKey(params as any) } },
  );

  const approve = useApproveLicenseRenewal();
  const reject = useRejectLicenseRenewal();
  const busy = approve.isPending || reject.isPending;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/license-renewals"] });
    queryClient.invalidateQueries({ queryKey: ["/api/licenses"] });
  };

  const viewPhoto = async (r: LicenseRenewal) => {
    try {
      const { url } = await apiRequest(`/admin/storage/sign?path=${encodeURIComponent(r.docKey)}`);
      await Linking.openURL(url);
    } catch (e: any) {
      const msg = e?.message || "Could not open the document.";
      if (Platform.OS === "web") window.alert(msg);
      else Alert.alert("Document unavailable", msg);
    }
  };

  const openDecision = (renewal: LicenseRenewal, action: "approve" | "reject") => {
    setNote("");
    setDecision({ renewal, action });
  };

  const submitDecision = async () => {
    if (!decision) return;
    const { renewal, action } = decision;
    const trimmed = note.trim();
    if (action === "reject" && !trimmed) {
      const msg = "A reason is required when rejecting. The officer will see it.";
      if (Platform.OS === "web") window.alert(msg);
      else Alert.alert("Reason required", msg);
      return;
    }
    try {
      if (action === "approve") {
        await approve.mutateAsync({ id: renewal.id, data: trimmed ? { decisionNote: trimmed } : {} });
      } else {
        await reject.mutateAsync({ id: renewal.id, data: { decisionNote: trimmed } });
      }
      invalidate();
      setDecision(null);
      setNote("");
    } catch (e: any) {
      const msg = e?.message || "Could not save your decision.";
      if (Platform.OS === "web") window.alert(msg);
      else Alert.alert("Action failed", msg);
    }
  };

  const officerName = (r: LicenseRenewal) =>
    [r.employeeFirstName, r.employeeLastName].filter(Boolean).join(" ") || r.employeeEmail || "Officer";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Licence Approvals</Text>
        <TouchableOpacity onPress={() => refetch()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Refresh">
          <Feather name="refresh-cw" size={16} color={colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}
            onPress={() => setFilter(f)}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f }}
            accessibilityLabel={`Filter ${f}`}
          >
            <Text style={[styles.filterText, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load renewals</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Retry"><Text style={{ color: colors.primary }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={renewals ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(renewals && renewals.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="check-circle" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {filter === "pending" ? "No renewals waiting for review" : "No renewals found"}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const tone = STATUS_TONE[item.status] ?? colors.mutedForeground;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.officer, { color: colors.foreground }]}>{officerName(item)}</Text>
                    {item.employeeEmail && <Text style={[styles.sub, { color: colors.mutedForeground }]}>{item.employeeEmail}</Text>}
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: tone + "20", borderColor: tone }]}>
                    <Text style={[styles.statusText, { color: tone }]}>{item.status.toUpperCase()}</Text>
                  </View>
                </View>

                <View style={styles.licRow}>
                  <Text style={[styles.licType, { color: colors.foreground }]}>{item.licenseType}</Text>
                  {item.licenseLevel != null && <LicenseLevelBadge level={item.licenseLevel} size="sm" />}
                </View>
                <Text style={[styles.sub, { color: colors.mutedForeground }]}>#{item.licenseNumber}</Text>
                <Text style={[styles.sub, { color: colors.mutedForeground }]}>
                  {item.licenseId ? "Renews existing licence" : "New licence"}
                </Text>
                <View style={styles.detailRow}>
                  <Feather name="clock" size={13} color={tone} />
                  <Text style={[styles.sub, { color: tone, fontWeight: "600" }]}>New expiry: {item.expiryDate}</Text>
                </View>
                {item.notes ? <Text style={[styles.noteText, { color: colors.mutedForeground }]}>"{item.notes}"</Text> : null}
                {item.decisionNote ? (
                  <Text style={[styles.noteText, { color: colors.mutedForeground }]}>Decision: {item.decisionNote}</Text>
                ) : null}

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.actionBtn, { borderColor: colors.border }]}
                    onPress={() => viewPhoto(item)}
                    accessibilityRole="button"
                    accessibilityLabel="View licence photo"
                  >
                    <Feather name="image" size={14} color={colors.foreground} />
                    <Text style={[styles.actionText, { color: colors.foreground }]}>Photo</Text>
                  </TouchableOpacity>
                  {item.status === "pending" && (
                    <>
                      <TouchableOpacity
                        style={[styles.actionBtn, { borderColor: "#22c55e", backgroundColor: "#22c55e20" }]}
                        onPress={() => openDecision(item, "approve")}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Approve renewal for ${officerName(item)}`}
                      >
                        <Feather name="check" size={14} color="#22c55e" />
                        <Text style={[styles.actionText, { color: "#22c55e" }]}>Approve</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.actionBtn, { borderColor: colors.destructive, backgroundColor: colors.destructive + "18" }]}
                        onPress={() => openDecision(item, "reject")}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Reject renewal for ${officerName(item)}`}
                      >
                        <Feather name="x" size={14} color={colors.destructive} />
                        <Text style={[styles.actionText, { color: colors.destructive }]}>Reject</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </View>
            );
          }}
        />
      )}

      <Modal visible={!!decision} transparent animationType="slide" onRequestClose={() => !busy && setDecision(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                {decision?.action === "approve" ? "Approve renewal" : "Reject renewal"}
              </Text>
              <TouchableOpacity onPress={() => !busy && setDecision(null)} accessibilityRole="button" accessibilityLabel="Close">
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {decision && (
              <Text style={[styles.sub, { color: colors.mutedForeground, marginBottom: 4 }]}>
                {officerName(decision.renewal)} — {decision.renewal.licenseType}
              </Text>
            )}
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
              {decision?.action === "approve" ? "Note (optional)" : "Reason (required, officer will see it)"}
            </Text>
            <TextInput
              style={[styles.noteInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
              value={note}
              onChangeText={setNote}
              placeholder={decision?.action === "approve" ? "Looks good" : "e.g. Photo is unreadable, please resubmit"}
              placeholderTextColor={colors.mutedForeground}
              multiline
              accessibilityLabel="Decision note"
            />
            <TouchableOpacity
              style={[styles.submitBtn, { backgroundColor: decision?.action === "approve" ? "#22c55e" : colors.destructive }]}
              onPress={submitDecision}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={decision?.action === "approve" ? "Confirm approval" : "Confirm rejection"}
              accessibilityState={{ disabled: busy, busy }}
            >
              {busy ? <ActivityIndicator color="#fff" /> : (
                <Text style={styles.submitText}>{decision?.action === "approve" ? "Approve" : "Reject"}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { flex: 1, fontSize: 22, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10, flexWrap: "wrap" },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 6 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  officer: { fontSize: 15, fontWeight: "700" },
  sub: { fontSize: 12 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: "700" },
  licRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  licType: { fontSize: 14, fontWeight: "600" },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  noteText: { fontSize: 12, fontStyle: "italic", marginTop: 2 },
  actions: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  actionText: { fontSize: 13, fontWeight: "600" },
  emptyText: { marginTop: 12, fontSize: 15, textAlign: "center" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  modalOverlay: { flex: 1, backgroundColor: "#000000bb", justifyContent: "flex-end" },
  modalCard: { borderRadius: 20, borderWidth: 1, padding: 20, gap: 12, margin: 12 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  fieldLabel: { fontSize: 12, fontWeight: "500" },
  noteInput: { minHeight: 80, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, textAlignVertical: "top" },
  submitBtn: { paddingVertical: 14, borderRadius: 10, alignItems: "center", marginTop: 4 },
  submitText: { fontWeight: "700", fontSize: 15, color: "#fff" },
});
