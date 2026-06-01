import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetEmployees, getGetEmployeesQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";

const STATUS_FILTERS = ["all", "active", "inactive", "pending"] as const;

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const NEW_USER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Subtle presence marker.
 *  - Green ringed dot ("Online") when lastActiveAt is within ~5 min.
 *  - Gold "NEW" pill when the user logged in for the first time within
 *    the last 7 days. Helps admins notice freshly-onboarded officers
 *    starting to use the app.
 * Renders nothing when neither applies, so quiet rows stay clean.
 */
function PresenceMarker({ item }: { item: any }) {
  const colors = useColors();
  const now = Date.now();
  const lastActiveMs = item.lastActiveAt ? new Date(item.lastActiveAt).getTime() : 0;
  const firstLoginMs = item.firstLoginAt ? new Date(item.firstLoginAt).getTime() : 0;
  const isOnline = lastActiveMs > 0 && now - lastActiveMs <= ONLINE_WINDOW_MS;
  const isNew = firstLoginMs > 0 && now - firstLoginMs <= NEW_USER_WINDOW_MS;
  if (!isOnline && !isNew) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {isNew && (
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
            backgroundColor: colors.accent + "25",
            borderWidth: 1,
            borderColor: colors.accent,
          }}
          accessibilityLabel="Recently activated account"
        >
          <Text style={{ fontSize: 9, fontWeight: "700", color: colors.accent, letterSpacing: 0.5 }}>NEW</Text>
        </View>
      )}
      {isOnline && (
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: "#22c55e",
            borderWidth: 2,
            borderColor: "#22c55e40",
          }}
          accessibilityLabel="Online now"
        />
      )}
    </View>
  );
}

export default function AdminEmployeesScreen() {
  const colors = useColors();
  const router = useRouter();
  const { status: statusParam } = useLocalSearchParams<{ status?: string }>();
  const [search, setSearch] = useState("");
  // Honour the ?status= query when the dashboard StatCards deep-link in.
  // Falls back to "all" so direct nav to the tab keeps the existing behaviour.
  const initialStatus = typeof statusParam === "string" && (STATUS_FILTERS as readonly string[]).includes(statusParam)
    ? statusParam
    : "all";
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
  const topPad = useTopPad();

  const empParams: any = { status: statusFilter === "all" ? undefined : statusFilter, search: search || undefined };
  const { data: employees, isLoading, error, refetch } = useGetEmployees(
    empParams,
    { query: { queryKey: getGetEmployeesQueryKey(empParams) } },
  );

  const getStatusColor = (status: string) => {
    if (status === "active") return "#22c55e";
    if (status === "inactive") return colors.mutedForeground;
    return colors.accent;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Personnel</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          onPress={() => router.push("/(admin)/employees/create")}
          accessibilityRole="button"
          accessibilityLabel="Add employee"
        >
          <Feather name="plus" size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={[styles.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="search" size={16} color={colors.mutedForeground} />
        <TextInput
          style={[styles.searchInput, { color: colors.foreground }]}
          placeholder="Search name or email..."
          placeholderTextColor={colors.mutedForeground}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          accessibilityLabel="Search personnel by name or email"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")} accessibilityRole="button" accessibilityLabel="Clear search">
            <Feather name="x" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, { borderColor: statusFilter === f ? colors.primary : colors.border, backgroundColor: statusFilter === f ? colors.primary + "20" : "transparent" }]}
            onPress={() => setStatusFilter(f)}
            accessibilityRole="button"
            accessibilityState={{ selected: statusFilter === f }}
            accessibilityLabel={`Filter by ${f === "all" ? "all statuses" : f}`}
          >
            <Text style={[styles.filterText, { color: statusFilter === f ? colors.primary : colors.mutedForeground }]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load employees</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Retry loading employees">
            <Text style={{ color: colors.primary }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={employees ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(employees && employees.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="users" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No employees found</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(`/(admin)/employees/${item.id}` as any)}
              accessibilityRole="button"
              accessibilityLabel={`${item.firstName} ${item.lastName}, ${item.status}${(item.expiringLicenseCount ?? 0) > 0 ? `, ${item.expiringLicenseCount} expiring licence${item.expiringLicenseCount === 1 ? "" : "s"}` : ""}`}
              accessibilityHint="Opens employee profile"
            >
              <View style={styles.cardRow}>
                <View style={[styles.avatar, { backgroundColor: colors.primary + "20" }]}>
                  <Text style={[styles.avatarText, { color: colors.primary }]}>
                    {item.firstName[0]}{item.lastName[0]}
                  </Text>
                </View>
                <View style={styles.cardInfo}>
                  <Text style={[styles.empName, { color: colors.foreground }]}>{item.firstName} {item.lastName}</Text>
                  <Text style={[styles.empEmail, { color: colors.mutedForeground }]}>{item.email}</Text>
                  {item.phone && <Text style={[styles.empPhone, { color: colors.mutedForeground }]}>{item.phone}</Text>}
                </View>
                <View style={styles.cardRight}>
                  <PresenceMarker item={item} />
                  <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status) }]} />
                  <Text style={[styles.statusText, { color: getStatusColor(item.status) }]}>{item.status}</Text>
                  {(item.expiringLicenseCount ?? 0) > 0 && (
                    <View style={[styles.licBadge, { backgroundColor: colors.destructive + "20" }]}>
                      <Text style={[styles.licBadgeText, { color: colors.destructive }]}>{item.expiringLicenseCount} expiring</Text>
                    </View>
                  )}
                </View>
              </View>
              {(item.skills?.length ?? 0) > 0 && (
                <View style={styles.skillRow}>
                  {item.skills!.slice(0, 3).map((s) => (
                    <View key={s} style={[styles.skillChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                      <Text style={[styles.skillText, { color: colors.mutedForeground }]}>{s}</Text>
                    </View>
                  ))}
                </View>
              )}
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
  searchBar: { flexDirection: "row", alignItems: "center", gap: 10, margin: 16, padding: 12, borderRadius: 10, borderWidth: 1 },
  searchInput: { flex: 1, fontSize: 15 },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, justifyContent: "center", alignItems: "center" },
  avatarText: { fontSize: 16, fontWeight: "700" },
  cardInfo: { flex: 1, gap: 2 },
  empName: { fontSize: 15, fontWeight: "600" },
  empEmail: { fontSize: 12 },
  empPhone: { fontSize: 12 },
  cardRight: { alignItems: "flex-end", gap: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  licBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  licBadgeText: { fontSize: 10, fontWeight: "600" },
  skillRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  skillChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  skillText: { fontSize: 11 },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
});
