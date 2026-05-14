import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Platform, Alert } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetShifts, getGetShiftsQueryKey, useGetMe, getGetMeQueryKey, useGetEmployee, getGetEmployeeQueryKey, claimShift } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import { LicenseLevelBadge, levelLabel } from "@/components/LicenseLevelBadge";

const FILTERS = ["available", "upcoming", "active", "completed"] as const;

export default function EmployeeShiftsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<typeof FILTERS[number]>("available");
  const [claiming, setClaiming] = useState<string | null>(null);
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const myUserId = (me as any)?.id as string | undefined;
  const { data: myEmployee } = useGetEmployee(myUserId!, {
    query: { queryKey: getGetEmployeeQueryKey(myUserId!), enabled: !!myUserId },
  });
  const myMaxLevel = (myEmployee as any)?.maxLicenseLevel as number | null | undefined;

  // Server filters automatically: returns assigned + open shifts the employee qualifies for.
  const statusParam = filter === "available" ? "upcoming" : filter;
  const { data: allShifts, isLoading, error, refetch } = useGetShifts({
    params: { status: statusParam },
    query: { queryKey: getGetShiftsQueryKey({ status: statusParam }) },
  });

  const shifts = (allShifts ?? []).filter((s: any) => {
    const isAssigned = (s.assignments ?? []).some((a: any) => a.employeeId === myUserId);
    if (filter === "available") return !isAssigned;
    return isAssigned;
  });

  const statusColor: Record<string, string> = { upcoming: colors.primary, active: "#22c55e", completed: colors.mutedForeground };

  const handleClaim = (shift: any) => {
    Alert.alert(
      "Sign Up For Shift",
      `${shift.title} @ ${shift.clientName}\n\nConfirm sign-up?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign Up",
          onPress: async () => {
            setClaiming(shift.id);
            try {
              await claimShift(shift.id);
              await queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
              Alert.alert("You're Signed Up", "This shift is now in your roster.");
            } catch (e: any) {
              const msg = e?.response?.data?.message || e?.message || "Could not sign up for this shift.";
              Alert.alert("Sign-Up Failed", msg);
            } finally {
              setClaiming(null);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Shifts</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
            <Feather name="award" size={11} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
              Your clearance: {levelLabel(myMaxLevel ?? null)}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
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
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load shifts</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]}><Text style={{ color: colors.primary }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={shifts}
          keyExtractor={(item: any) => item.id}
          scrollEnabled={shifts.length > 0}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name={filter === "available" ? "inbox" : "calendar"} size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {filter === "available" ? "No open shifts you qualify for right now" : `No ${filter} shifts`}
              </Text>
            </View>
          }
          renderItem={({ item }: { item: any }) => {
            const sc = statusColor[item.status] || colors.mutedForeground;
            const duration = ((new Date(item.endTime).getTime() - new Date(item.startTime).getTime()) / 3600000).toFixed(1);
            const start = new Date(item.startTime);
            const filled = (item.assignments ?? []).length;
            const isAvailable = filter === "available";
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: sc, borderLeftWidth: 3 }]}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.shiftTitle, { color: colors.foreground }]}>{item.title}</Text>
                    <Text style={[styles.clientName, { color: colors.primary }]}>{item.clientName}</Text>
                  </View>
                  <View style={[styles.durationBadge, { backgroundColor: sc + "20", borderColor: sc }]}>
                    <Text style={[styles.durationText, { color: sc }]}>{duration}h</Text>
                  </View>
                </View>

                <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <LicenseLevelBadge level={item.requiredLicenseLevel} size="sm" />
                  <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
                    {filled}/{item.headcount} filled
                  </Text>
                </View>

                <View style={styles.detailRow}>
                  <Feather name="map-pin" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.mutedForeground }]} numberOfLines={1}>{item.location}</Text>
                </View>

                <View style={[styles.timeBlock, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                  <View style={styles.timeItem}>
                    <Text style={[styles.timeLabel, { color: colors.mutedForeground }]}>DATE</Text>
                    <Text style={[styles.timeValue, { color: colors.foreground }]}>
                      {start.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
                    </Text>
                  </View>
                  <View style={[styles.timeDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.timeItem}>
                    <Text style={[styles.timeLabel, { color: colors.mutedForeground }]}>START</Text>
                    <Text style={[styles.timeValue, { color: colors.foreground }]}>
                      {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                  <View style={[styles.timeDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.timeItem}>
                    <Text style={[styles.timeLabel, { color: colors.mutedForeground }]}>END</Text>
                    <Text style={[styles.timeValue, { color: colors.foreground }]}>
                      {new Date(item.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                </View>

                <View style={styles.rateRow}>
                  <Feather name="dollar-sign" size={13} color={colors.primary} />
                  <Text style={[styles.rateText, { color: colors.primary }]}>${parseFloat(item.hourlyRate).toFixed(2)}/hr</Text>
                  <Text style={[styles.earnText, { color: colors.mutedForeground }]}>
                    ≈ ${(parseFloat(item.hourlyRate) * parseFloat(duration)).toFixed(2)} total
                  </Text>
                </View>

                {item.notes && (
                  <View style={[styles.notesBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Feather name="file-text" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.notesText, { color: colors.mutedForeground }]}>{item.notes}</Text>
                  </View>
                )}

                {isAvailable && (
                  <TouchableOpacity
                    style={[styles.claimBtn, { backgroundColor: colors.primary, opacity: claiming === item.id ? 0.6 : 1 }]}
                    onPress={() => handleClaim(item)}
                    disabled={claiming === item.id}
                  >
                    {claiming === item.id ? (
                      <ActivityIndicator color={colors.primaryForeground} />
                    ) : (
                      <>
                        <Feather name="check-circle" size={16} color={colors.primaryForeground} />
                        <Text style={[styles.claimText, { color: colors.primaryForeground }]}>Sign Up For This Shift</Text>
                      </>
                    )}
                  </TouchableOpacity>
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
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, alignItems: "center" },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, flexWrap: "wrap" },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  shiftTitle: { fontSize: 15, fontWeight: "700" },
  clientName: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  durationBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  durationText: { fontSize: 13, fontWeight: "700" },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  detailText: { fontSize: 12, flex: 1 },
  timeBlock: { flexDirection: "row", borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  timeItem: { flex: 1, alignItems: "center", paddingVertical: 10 },
  timeLabel: { fontSize: 9, fontWeight: "700", letterSpacing: 1, marginBottom: 3 },
  timeValue: { fontSize: 14, fontWeight: "600" },
  timeDivider: { width: 1 },
  rateRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  rateText: { fontSize: 13, fontWeight: "700" },
  earnText: { fontSize: 12, flex: 1 },
  notesBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: 6, borderWidth: 1 },
  notesText: { fontSize: 12, flex: 1, lineHeight: 16 },
  emptyText: { marginTop: 12, fontSize: 14, textAlign: "center" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  claimBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 8, marginTop: 4 },
  claimText: { fontSize: 14, fontWeight: "700" },
});
