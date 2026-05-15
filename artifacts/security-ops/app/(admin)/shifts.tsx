import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetShifts, getGetShiftsQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

const STATUS_FILTERS = ["upcoming", "active", "completed", "cancelled"] as const;

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const map: Record<string, string> = { upcoming: colors.primary, active: "#22c55e", completed: colors.mutedForeground, cancelled: colors.destructive };
  const c = map[status] || colors.mutedForeground;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

export default function AdminShiftsScreen() {
  const colors = useColors();
  const router = useRouter();
  const [filter, setFilter] = useState<string>("upcoming");
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: shifts, isLoading, error, refetch } = useGetShifts(
    { status: filter as any },
    { query: { queryKey: getGetShiftsQueryKey({ status: filter as any }) } },
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Shifts</Text>
        <TouchableOpacity style={[styles.addBtn, { backgroundColor: colors.primary }]} onPress={() => router.push("/(admin)/shifts/create")}>
          <Feather name="plus" size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={styles.filterScroll}>
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
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load shifts</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]}>
            <Text style={{ color: colors.primary }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={shifts ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(shifts && shifts.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="calendar" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No {filter} shifts</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(`/(admin)/shifts/${item.id}` as any)}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.shiftTitle, { color: colors.foreground }]}>{item.title}</Text>
                <StatusBadge status={item.status} />
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation?.(); router.push(`/(admin)/shifts/edit/${item.id}` as any); }}
                  style={[styles.editBtn, { borderColor: colors.primary }]}
                  accessibilityLabel={`Edit ${item.title}`}
                  hitSlop={8}
                >
                  <Feather name="edit-2" size={14} color={colors.primary} />
                </TouchableOpacity>
              </View>
              <View style={styles.clientRow}>
                <Feather name="briefcase" size={13} color={colors.accent} />
                <Text style={[styles.clientText, { color: colors.accent }]}>{item.clientName}</Text>
                {item.isRepeat && <Feather name="repeat" size={13} color={colors.mutedForeground} />}
              </View>
              <View style={styles.detailRow}>
                <Feather name="map-pin" size={13} color={colors.mutedForeground} />
                <Text style={[styles.detailText, { color: colors.mutedForeground }]} numberOfLines={1}>{item.location}</Text>
              </View>
              <View style={styles.timeRow}>
                <Feather name="clock" size={13} color={colors.mutedForeground} />
                <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
                  {new Date(item.startTime).toLocaleString()} – {new Date(item.endTime).toLocaleTimeString()}
                </Text>
              </View>
              <View style={styles.bottomRow}>
                <View style={styles.rateTag}>
                  <Text style={[styles.rateText, { color: colors.primary }]}>${parseFloat(item.hourlyRate as any).toFixed(2)}/hr</Text>
                  {item.billableRate && <Text style={[styles.billText, { color: colors.mutedForeground }]}> · ${parseFloat(item.billableRate as any).toFixed(2)} billable</Text>}
                </View>
                <View style={styles.assignRow}>
                  <Feather name="users" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.assignText, { color: colors.mutedForeground }]}>{item.assignments?.length ?? 0} assigned</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  addBtn: { width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  filterScroll: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12, flexWrap: "wrap" },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  shiftTitle: { fontSize: 15, fontWeight: "700", flex: 1, marginRight: 8 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  editBtn: { padding: 6, borderRadius: 6, borderWidth: 1, marginLeft: 6 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  clientRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  clientText: { fontSize: 13, fontWeight: "600" },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  detailText: { fontSize: 12, flex: 1 },
  bottomRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  rateTag: { flexDirection: "row", alignItems: "center" },
  rateText: { fontSize: 13, fontWeight: "700" },
  billText: { fontSize: 12 },
  assignRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  assignText: { fontSize: 12 },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
});
