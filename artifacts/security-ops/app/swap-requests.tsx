import React, { useCallback, useEffect, useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, Platform,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/utils/api";
import { confirmAction, notify } from "@/utils/confirm";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { formatTime, formatDateTime } from "@/utils/time";

type SwapRow = {
  id: string;
  assignmentId: string;
  requestingUserId: string;
  targetUserId: string;
  status: "pending" | "accepted" | "approved" | "rejected" | "declined" | "cancelled";
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  siteName: string | null;
  requesterFirstName: string | null;
  requesterLastName: string | null;
};

const STATUS_COLOR: Record<SwapRow["status"], string> = {
  pending: "#f59e0b",
  accepted: "#3b82f6",
  approved: "#22c55e",
  rejected: "#ef4444",
  declined: "#ef4444",
  cancelled: "#6b7280",
};

export default function SwapRequestsScreen() {
  const colors = useColors();
  const topPad = useTopPad();
  const router = useRouter();
  const { user } = useAuth();
  const me = user?.id;
  const [rows, setRows] = useState<SwapRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest("/me/swap-requests");
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      notify("Could not load swap requests", e?.message ?? "Please try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const respond = async (row: SwapRow, status: "accepted" | "declined") => {
    const ok = await confirmAction({
      title: status === "accepted" ? "Cover this shift?" : "Decline swap?",
      message: status === "accepted"
        ? "If admin approves, this shift becomes yours."
        : "The requester will be notified.",
      confirmText: status === "accepted" ? "Accept" : "Decline",
      destructive: status === "declined",
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await apiRequest(`/shifts/swap-requests/${row.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (e: any) {
      notify("Action failed", e?.message ?? "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (row: SwapRow) => {
    const ok = await confirmAction({
      title: "Cancel swap request?",
      message: "Your shift stays assigned to you.",
      confirmText: "Cancel request",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await apiRequest(`/shifts/swap-requests/${row.id}/cancel`, { method: "POST" });
      await load();
    } catch (e: any) {
      notify("Could not cancel", e?.message ?? "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const renderItem = ({ item }: { item: SwapRow }) => {
    const isIncoming = item.targetUserId === me;
    const start = item.shiftStart ? new Date(item.shiftStart) : null;
    const end = item.shiftEnd ? new Date(item.shiftEnd) : null;
    const sc = STATUS_COLOR[item.status];
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.dirLabel, { color: colors.mutedForeground }]}>
            {isIncoming ? "INCOMING" : "OUTGOING"}
          </Text>
          <View style={[styles.statusPill, { borderColor: sc, backgroundColor: sc + "20" }]}>
            <Text style={[styles.statusText, { color: sc }]}>{item.status.toUpperCase()}</Text>
          </View>
        </View>

        <Text style={[styles.title, { color: colors.foreground }]}>
          {item.siteName ?? "Shift"}
        </Text>
        {start && (
          <Text style={[styles.meta, { color: colors.mutedForeground }]}>
            {formatDateTime(start)}
            {end ? ` – ${formatTime(end)}` : ""}
          </Text>
        )}

        <Text style={[styles.meta, { color: colors.mutedForeground, marginTop: 6 }]}>
          {isIncoming
            ? `From: ${item.requesterFirstName ?? ""} ${item.requesterLastName ?? ""}`.trim()
            : "You requested this swap"}
        </Text>
        {item.reason && (
          <Text style={[styles.reason, { color: colors.foreground }]}>"{item.reason}"</Text>
        )}

        {isIncoming && item.status === "pending" && (
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: "#22c55e", opacity: busyId === item.id ? 0.6 : 1 }]}
              onPress={() => respond(item, "accepted")}
              disabled={busyId === item.id}
              accessibilityRole="button"
              accessibilityLabel={`Accept swap for ${item.siteName ?? "shift"}`}
              accessibilityHint="If admin approves, this shift becomes yours"
              accessibilityState={{ disabled: busyId === item.id, busy: busyId === item.id }}
            >
              <Feather name="check" size={14} color="#fff" />
              <Text style={[styles.btnText, { color: "#fff" }]}>Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { borderWidth: 1.5, borderColor: colors.destructive, opacity: busyId === item.id ? 0.6 : 1 }]}
              onPress={() => respond(item, "declined")}
              disabled={busyId === item.id}
              accessibilityRole="button"
              accessibilityLabel={`Decline swap for ${item.siteName ?? "shift"}`}
              accessibilityHint="The requester will be notified"
              accessibilityState={{ disabled: busyId === item.id, busy: busyId === item.id }}
            >
              <Feather name="x" size={14} color={colors.destructive} />
              <Text style={[styles.btnText, { color: colors.destructive }]}>Decline</Text>
            </TouchableOpacity>
          </View>
        )}

        {!isIncoming && (item.status === "pending" || item.status === "accepted") && (
          <TouchableOpacity
            style={[styles.btn, { borderWidth: 1.5, borderColor: colors.destructive, marginTop: 10, opacity: busyId === item.id ? 0.6 : 1 }]}
            onPress={() => cancel(item)}
            disabled={busyId === item.id}
            accessibilityRole="button"
            accessibilityLabel={`Cancel your swap request for ${item.siteName ?? "shift"}`}
            accessibilityHint="Your shift stays assigned to you"
            accessibilityState={{ disabled: busyId === item.id, busy: busyId === item.id }}
          >
            <Feather name="x" size={14} color={colors.destructive} />
            <Text style={[styles.btnText, { color: colors.destructive }]}>Cancel request</Text>
          </TouchableOpacity>
        )}

        {item.status === "accepted" && (
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            Awaiting admin approval to finalise the swap.
          </Text>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: topPad }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground, fontSize: 18 }]} accessibilityRole="header">Shift Swaps</Text>
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={rows ?? []}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="inbox" size={36} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 10 }}>No swap requests</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 6 },
  title: { fontSize: 16, fontWeight: "700" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  dirLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1.5 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  meta: { fontSize: 12, marginTop: 4 },
  reason: { fontSize: 13, fontStyle: "italic", marginTop: 8 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8 },
  btnText: { fontSize: 13, fontWeight: "700" },
  note: { fontSize: 11, marginTop: 8, fontStyle: "italic" },
});
