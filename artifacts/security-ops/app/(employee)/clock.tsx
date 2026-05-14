import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useClockIn, useClockOut, useGetActiveTimeEntry, getGetActiveTimeEntryQueryKey, useGetTimeEntries, getGetTimeEntriesQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Location from "expo-location";

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function EmployeeClockScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const topPad = Platform.OS === "web" ? 67 : 0;
  const [elapsed, setElapsed] = useState(0);
  const [location, setLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);

  const { data: currentEntry, isLoading: entryLoading } = useGetActiveTimeEntry({
    query: { queryKey: getGetActiveTimeEntryQueryKey() }
  });

  const { data: recentEntries } = useGetTimeEntries(
    {},
    { query: { queryKey: getGetTimeEntriesQueryKey({}) } },
  );

  const clockInMutation = useClockIn();
  const clockOutMutation = useClockOut();

  const isClockedIn = !!currentEntry?.id;

  useEffect(() => {
    if (!isClockedIn || !currentEntry?.clockInTime) { setElapsed(0); return; }
    const startMs = new Date(currentEntry.clockInTime).getTime();
    const update = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isClockedIn, currentEntry?.clockInTime]);

  const getLocation = async () => {
    setLocationLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setLocationLoading(false); return; }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLocation({ lat: loc.coords.latitude, lon: loc.coords.longitude });
    } catch { /* location optional */ }
    setLocationLoading(false);
  };

  useEffect(() => { getLocation(); }, []);

  const handleClockIn = async () => {
    Alert.alert("Clock In", "Start your shift now?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clock In", onPress: async () => {
          await clockInMutation.mutateAsync({
            data: { lat: location?.lat ?? 0, lng: location?.lon ?? 0 } as any,
          });
          queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey() });
        }
      }
    ]);
  };

  const handleClockOut = async () => {
    if (!currentEntry?.id) return;
    Alert.alert("Clock Out", "End your shift now?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clock Out", style: "destructive", onPress: async () => {
          await clockOutMutation.mutateAsync({
            data: { timeEntryId: currentEntry.id, lat: location?.lat ?? 0, lng: location?.lon ?? 0 } as any,
          });
          queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey() });
        }
      }
    ]);
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Time Clock</Text>
        <TouchableOpacity onPress={getLocation} style={[styles.locBtn, { borderColor: colors.border }]}>
          {locationLoading
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Feather name="map-pin" size={16} color={location ? colors.primary : colors.mutedForeground} />
          }
        </TouchableOpacity>
      </View>

      <View style={[styles.clockFace, { backgroundColor: colors.card, borderColor: isClockedIn ? "#22c55e" : colors.border }]}>
        <View style={[styles.clockRing, { borderColor: isClockedIn ? "#22c55e" : colors.border }]}>
          <Text style={[styles.clockTime, { color: isClockedIn ? "#22c55e" : colors.mutedForeground }]}>
            {isClockedIn ? formatDuration(elapsed) : "00:00:00"}
          </Text>
          <Text style={[styles.clockStatus, { color: isClockedIn ? "#22c55e" : colors.mutedForeground }]}>
            {isClockedIn ? "ON DUTY" : "OFF DUTY"}
          </Text>
        </View>

        {isClockedIn && currentEntry?.clockInTime && (
          <Text style={[styles.clockInTime, { color: colors.mutedForeground }]}>
            Clocked in at {new Date(currentEntry.clockInTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}

        <View style={styles.locationRow}>
          <Feather name="map-pin" size={14} color={location ? "#22c55e" : colors.mutedForeground} />
          <Text style={[styles.locationText, { color: location ? "#22c55e" : colors.mutedForeground }]}>
            {location ? `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}` : "Location not available"}
          </Text>
        </View>

        {entryLoading ? (
          <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 20 }} />
        ) : (
          <TouchableOpacity
            style={[styles.mainBtn, { backgroundColor: isClockedIn ? colors.destructive : "#22c55e" }]}
            onPress={isClockedIn ? handleClockOut : handleClockIn}
            disabled={clockInMutation.isPending || clockOutMutation.isPending}
          >
            {(clockInMutation.isPending || clockOutMutation.isPending) ? (
              <ActivityIndicator color="#fff" size="large" />
            ) : (
              <>
                <Feather name={isClockedIn ? "square" : "play"} size={28} color="#fff" />
                <Text style={styles.mainBtnText}>{isClockedIn ? "CLOCK OUT" : "CLOCK IN"}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {(recentEntries?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>RECENT TIME ENTRIES</Text>
          {recentEntries!.slice(0, 5).map((entry: any) => {
            const hrs = entry.hoursWorked ? parseFloat(entry.hoursWorked as any).toFixed(2) : null;
            return (
              <View key={entry.id} style={[styles.entryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.entryHeader}>
                  <Text style={[styles.entryDate, { color: colors.foreground }]}>
                    {new Date(entry.clockInTime).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
                  </Text>
                  {hrs && (
                    <View style={[styles.hrsBadge, { backgroundColor: colors.primary + "20", borderColor: colors.primary }]}>
                      <Text style={[styles.hrsText, { color: colors.primary }]}>{hrs}h</Text>
                    </View>
                  )}
                </View>
                <View style={styles.entryRow}>
                  <Feather name="play" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.entryTime, { color: colors.mutedForeground }]}>
                    {new Date(entry.clockInTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                  {entry.clockOutTime && <>
                    <Feather name="arrow-right" size={13} color={colors.mutedForeground} />
                    <Feather name="square" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.entryTime, { color: colors.mutedForeground }]}>
                      {new Date(entry.clockOutTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </>}
                  {entry.clockInLat && (
                    <View style={styles.gpsTag}>
                      <Feather name="map-pin" size={11} color="#22c55e" />
                      <Text style={{ color: "#22c55e", fontSize: 11 }}>GPS</Text>
                    </View>
                  )}
                </View>
                {entry.notes && <Text style={[styles.entryNotes, { color: colors.mutedForeground }]}>{entry.notes}</Text>}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  locBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  clockFace: { margin: 16, padding: 24, borderRadius: 20, borderWidth: 2, alignItems: "center", gap: 14 },
  clockRing: { width: 200, height: 200, borderRadius: 100, borderWidth: 3, justifyContent: "center", alignItems: "center", gap: 6 },
  clockTime: { fontSize: 36, fontWeight: "800", fontVariant: ["tabular-nums"] as any },
  clockStatus: { fontSize: 13, fontWeight: "700", letterSpacing: 3 },
  clockInTime: { fontSize: 13 },
  locationRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  locationText: { fontSize: 12 },
  mainBtn: { width: 120, height: 120, borderRadius: 60, justifyContent: "center", alignItems: "center", gap: 8, marginTop: 8 },
  mainBtnText: { color: "#fff", fontWeight: "800", fontSize: 14, letterSpacing: 1 },
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  entryCard: { borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 8, gap: 6 },
  entryHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  entryDate: { fontSize: 14, fontWeight: "600" },
  hrsBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  hrsText: { fontSize: 12, fontWeight: "700" },
  entryRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  entryTime: { fontSize: 13 },
  gpsTag: { flexDirection: "row", alignItems: "center", gap: 2, marginLeft: 6 },
  entryNotes: { fontSize: 12, fontStyle: "italic" },
});
