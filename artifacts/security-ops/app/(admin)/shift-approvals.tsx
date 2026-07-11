import React, { useMemo } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetShifts, getGetShiftsQueryKey, useUpdateShiftAssignment } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { formatDateTime, formatTime } from "@/utils/time";

type PendingClaim = {
  assignmentId: string;
  shiftId: string;
  employeeName: string;
  shiftTitle: string;
  clientName: string;
  location: string;
  startTime: string;
  endTime: string;
  requiredLicenseLevel: number;
};

export default function ShiftApprovalsScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();

  // Pending self-claims are derived client-side from the upcoming-shifts list —
  // GET /shifts already returns each shift's assignments with id/status/
  // employeeName, so no dedicated endpoint is needed.
  const { data: shifts, isLoading, refetch } = useGetShifts(
    { status: "upcoming" as any },
    { query: { queryKey: getGetShiftsQueryKey({ status: "upcoming" as any }) } },
  );

  const update = useUpdateShiftAssignment();

  const pending = useMemo<PendingClaim[]>(() => {
    const rows: PendingClaim[] = [];
    for (const s of (shifts ?? []) as any[]) {
      for (const a of (s.assignments ?? []) as any[]) {
        if (a.status !== "pending_approval") continue;
        rows.push({
          assignmentId: a.id,
          shiftId: s.id,
          employeeName: a.employeeName ?? "Officer",
          shiftTitle: s.title ?? "Shift",
          clientName: s.clientName ?? "",
          location: s.location ?? "",
          startTime: s.startTime,
          endTime: s.endTime,
          requiredLicenseLevel: s.requiredLicenseLevel ?? 0,
        });
      }
    }
    return rows.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }, [shifts]);

  const decide = (row: PendingClaim, decision: "accepted" | "declined") => {
    update
      .mutateAsync({ id: row.shiftId, assignmentId: row.assignmentId, data: { status: decision } } as any)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey({ status: "upcoming" as any }) });
      })
      .catch((e: any) =>
        Alert.alert("Failed", e?.response?.data?.message || e?.message || "Could not update the request."),
      );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Shift Approvals</Text>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <FlatList
          data={pending}
          keyExtractor={(item) => item.assignmentId}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="check-circle" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No shift claims awaiting approval.</Text>
            </View>
          }
          refreshing={false}
          onRefresh={refetch}
          renderItem={({ item }) => {
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: colors.foreground }]}>{item.employeeName}</Text>
                    <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={2}>
                      <Feather name="briefcase" size={11} color={colors.mutedForeground} />{" "}
                      {item.shiftTitle}{item.clientName ? ` · ${item.clientName}` : ""}
                    </Text>
                    {item.location ? (
                      <Text style={[styles.sub, { color: colors.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
                        <Feather name="map-pin" size={11} color={colors.mutedForeground} />{" "}
                        {item.location}
                      </Text>
                    ) : null}
                  </View>
                  <View style={[styles.badge, { backgroundColor: colors.accent + "20", borderColor: colors.accent }]}>
                    <Text style={{ color: colors.accent, fontSize: 10, fontWeight: "700" }}>L{item.requiredLicenseLevel}</Text>
                  </View>
                </View>

                <Text style={[styles.line, { color: colors.mutedForeground }]}>
                  <Feather name="clock" size={11} color={colors.mutedForeground} />{" "}
                  {formatDateTime(item.startTime)} – {formatTime(item.endTime)}
                </Text>

                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => decide(item, "accepted")}
                    style={[styles.actBtn, { backgroundColor: "#22c55e" }]}
                    disabled={update.isPending}
                    accessibilityRole="button"
                    accessibilityLabel={`Approve ${item.employeeName} for ${item.shiftTitle}`}
                    accessibilityState={{ disabled: update.isPending, busy: update.isPending }}
                  >
                    <Feather name="check" size={14} color="#fff" />
                    <Text style={[styles.actText, { color: "#fff" }]}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => decide(item, "declined")}
                    style={[styles.actBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.destructive }]}
                    disabled={update.isPending}
                    accessibilityRole="button"
                    accessibilityLabel={`Decline ${item.employeeName} for ${item.shiftTitle}`}
                    accessibilityState={{ disabled: update.isPending, busy: update.isPending }}
                  >
                    <Feather name="x" size={14} color={colors.destructive} />
                    <Text style={[styles.actText, { color: colors.destructive }]}>Decline</Text>
                  </TouchableOpacity>
                </View>
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
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 14, fontWeight: "700" },
  sub: { fontSize: 12, marginTop: 2 },
  line: { fontSize: 12 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  actBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderRadius: 8 },
  actText: { fontWeight: "700", fontSize: 13 },
});
