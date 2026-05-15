import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, ActivityIndicator, TouchableOpacity, Linking } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetActiveOfficers, getGetActiveOfficersQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import LiveOfficerMap from "@/components/LiveOfficerMap";
import { formatDistanceToNow } from "date-fns";

export default function AdminLiveMapScreen() {
  const colors = useColors();
  const topPad = Platform.OS === "web" ? 12 : 0;

  const { data, isLoading, refetch, isFetching } = useGetActiveOfficers({
    query: {
      queryKey: getGetActiveOfficersQueryKey(),
      refetchInterval: 30_000, // refresh every 30s while screen is open
    },
  });

  const officers = (data ?? []) as any[];

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 120, paddingTop: topPad }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Live Map</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {officers.length} officer{officers.length === 1 ? "" : "s"} currently on duty
          </Text>
        </View>
        <TouchableOpacity onPress={() => refetch()} style={[styles.refresh, { borderColor: colors.border }]}>
          {isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="refresh-cw" size={16} color={colors.primary} />}
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <>
          <LiveOfficerMap officers={officers} height={380} />

          <View style={styles.list}>
            {officers.length === 0 ? (
              <View style={styles.emptyBox}>
                <Feather name="users" size={36} color={colors.mutedForeground} />
                <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                  No officers are currently clocked in.
                </Text>
              </View>
            ) : (
              officers.map((o: any) => {
                const lat = o.lastLat ?? o.clockInLat;
                const lng = o.lastLng ?? o.clockInLng;
                const ago = o.lastLocationAt
                  ? formatDistanceToNow(new Date(o.lastLocationAt), { addSuffix: true })
                  : "since clock-in";
                return (
                  <View key={o.timeEntryId} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <View style={[styles.dot, { backgroundColor: "#22c55e" }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.name, { color: colors.foreground }]}>
                        {o.firstName} {o.lastName}
                      </Text>
                      <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {o.shiftTitle ? `${o.shiftTitle}` : "Shift"} {o.siteName ? `• ${o.siteName}` : ""}
                      </Text>
                      <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                        Last seen {ago}
                      </Text>
                    </View>
                    {lat && lng && (
                      <TouchableOpacity
                        onPress={() => Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)}
                        style={[styles.openMap, { borderColor: colors.primary }]}
                      >
                        <Feather name="external-link" size={14} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}>Maps</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  title: { fontSize: 22, fontWeight: "700" },
  subtitle: { fontSize: 13, marginTop: 2 },
  refresh: { padding: 10, borderRadius: 8, borderWidth: 1 },
  list: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  emptyBox: { alignItems: "center", paddingVertical: 40, gap: 8 },
  empty: { fontSize: 14 },
  card: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, borderWidth: 1, gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 15, fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 2 },
  openMap: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
});
