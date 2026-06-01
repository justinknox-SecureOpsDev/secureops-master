import React, { useRef, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, Platform, ActivityIndicator, TouchableOpacity, Linking, Animated } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetActiveOfficers, getGetActiveOfficersQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import LiveOfficerMap from "@/components/LiveOfficerMap";
import { formatDistanceToNow } from "date-fns";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useHighlightFlash } from "@/hooks/useHighlightFlash";

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

export default function AdminLiveMapScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = Platform.OS === "web" ? 12 : 0;
  const openOfficer = (userId: string) => router.push(`/(admin)/employees/${userId}` as any);

  const { data, isLoading, refetch, isFetching } = useGetActiveOfficers({
    query: {
      queryKey: getGetActiveOfficersQueryKey(),
      refetchInterval: 30_000, // refresh every 30s while screen is open
    },
  });

  const officers = (data ?? []) as any[];

  // Deep-link focus: geofence-breach / emergency alerts pass userId (the
  // officer) and missed-checkpoint passes timeEntryId. Resolve both to a userId
  // so we can recenter the map + flash the matching list row. Stale ids no-op.
  const { userId: focusUserParam, timeEntryId: focusTeParam, _hlTs } =
    useLocalSearchParams<{ userId?: string; timeEntryId?: string; _hlTs?: string }>();
  const focusUserId =
    focusUserParam ||
    (focusTeParam ? officers.find((o) => o.timeEntryId === focusTeParam)?.userId : undefined) ||
    undefined;
  const scrollRef = useRef<ScrollView>(null);
  const listY = useRef(0);
  const rowOffsets = useRef<Record<string, number>>({});
  const flashAnim = useHighlightFlash(focusUserId ? `${focusUserId}:${_hlTs ?? ""}` : null);

  useEffect(() => {
    if (!focusUserId) return;
    const t = setTimeout(() => {
      const rel = rowOffsets.current[focusUserId];
      if (rel == null) return; // officer not in the active list — leave scroll alone
      scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + rel - 24), animated: true });
    }, 400);
    return () => clearTimeout(t);
  }, [focusUserId, _hlTs, officers]);

  return (
    <ScrollView ref={scrollRef} style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 120, paddingTop: topPad }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Live Map</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {officers.length} officer{officers.length === 1 ? "" : "s"} currently on duty
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => refetch()}
          style={[styles.refresh, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Refresh officer list"
          accessibilityState={{ busy: isFetching }}
        >
          {isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="refresh-cw" size={16} color={colors.primary} />}
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <>
          <LiveOfficerMap
            officers={officers}
            height={380}
            onSelectOfficer={openOfficer}
            focusUserId={focusUserId}
            focusKey={_hlTs}
          />

          <View
            style={styles.list}
            onLayout={(e) => { listY.current = e.nativeEvent.layout.y; }}
          >
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
                const isHighlighted = !!focusUserId && o.userId === focusUserId;
                return (
                  <AnimatedTouchable
                    key={o.timeEntryId}
                    onLayout={(e: any) => { rowOffsets.current[o.userId] = e.nativeEvent.layout.y; }}
                    onPress={() => openOfficer(o.userId)}
                    accessibilityRole="button"
                    accessibilityLabel={`View profile for ${o.firstName} ${o.lastName}`}
                    style={[styles.card, {
                      backgroundColor: isHighlighted
                        ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.card, colors.primary + "26"] })
                        : colors.card,
                      borderColor: isHighlighted
                        ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.border, colors.primary] })
                        : colors.border,
                      borderWidth: isHighlighted
                        ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2] })
                        : 1,
                    }]}
                  >
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
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${o.firstName} ${o.lastName}'s location in Google Maps`}
                      >
                        <Feather name="external-link" size={14} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}>Maps</Text>
                      </TouchableOpacity>
                    )}
                    <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
                  </AnimatedTouchable>
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
