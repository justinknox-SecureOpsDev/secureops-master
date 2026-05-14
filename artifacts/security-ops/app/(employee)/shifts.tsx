import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetMyShifts, getGetMyShiftsQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";

const FILTERS = ["upcoming", "active", "completed"] as const;

export default function EmployeeShiftsScreen() {
  const colors = useColors();
  const [filter, setFilter] = useState<string>("upcoming");
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: shifts, isLoading, error, refetch } = useGetMyShifts({
    params: { status: filter },
    query: { queryKey: getGetMyShiftsQueryKey({ status: filter }) }
  });

  const statusColor: Record<string, string> = { upcoming: colors.primary, active: "#22c55e", completed: colors.mutedForeground };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>My Shifts</Text>
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
          data={shifts ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(shifts && shifts.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="calendar" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No {filter} shifts</Text>
            </View>
          }
          renderItem={({ item }) => {
            const sc = statusColor[item.status] || colors.mutedForeground;
            const duration = ((new Date(item.endTime).getTime() - new Date(item.startTime).getTime()) / 3600000).toFixed(1);
            const start = new Date(item.startTime);
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
                  <Text style={[styles.rateText, { color: colors.primary }]}>${parseFloat(item.hourlyRate as any).toFixed(2)}/hr</Text>
                  <Text style={[styles.earnText, { color: colors.mutedForeground }]}>
                    ≈ ${(parseFloat(item.hourlyRate as any) * parseFloat(duration)).toFixed(2)} total
                  </Text>
                  {item.isRepeat && (
                    <View style={styles.repeatRow}>
                      <Feather name="repeat" size={13} color={colors.mutedForeground} />
                      <Text style={[styles.repeatText, { color: colors.mutedForeground }]}>Repeating</Text>
                    </View>
                  )}
                </View>

                {item.notes && (
                  <View style={[styles.notesBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Feather name="file-text" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.notesText, { color: colors.mutedForeground }]}>{item.notes}</Text>
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
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, padding: 16, paddingBottom: 8 },
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
  repeatRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  repeatText: { fontSize: 12 },
  notesBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: 6, borderWidth: 1 },
  notesText: { fontSize: 12, flex: 1, lineHeight: 16 },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
});
