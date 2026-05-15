import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useClockIn, useClockOut, useGetActiveTimeEntry, getGetActiveTimeEntryQueryKey, useGetTimeEntries, getGetTimeEntriesQueryKey, updateMyLocation, useGetSites, getGetSitesQueryKey } from "@workspace/api-client-react";
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

  // Web preview (canvas iframe) often blocks geolocation. Let the user pick a
  // site manually as a fallback so the clock function is testable on web.
  const isWeb = Platform.OS === "web";
  const [showSitePicker, setShowSitePicker] = useState(false);
  const { data: sitesList } = useGetSites({} as any, {
    query: { queryKey: getGetSitesQueryKey({} as any), enabled: isWeb },
  });

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

  // While clocked in, push location to the server every 60s so admins see live map updates.
  useEffect(() => {
    if (!isClockedIn) return;
    let cancelled = false;
    const ping = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        const lat = loc.coords.latitude;
        const lng = loc.coords.longitude;
        setLocation({ lat, lon: lng });
        await updateMyLocation({ lat, lng });
      } catch { /* ignore */ }
    };
    ping();
    const t = setInterval(ping, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isClockedIn]);

  const performClockIn = async (lat: number, lng: number, siteLabel?: string) => {
    try {
      const result: any = await clockInMutation.mutateAsync({
        data: { lat, lng } as any,
      });
      queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey() });
      const name = result?.geoResolved?.siteName ?? siteLabel;
      if (name) {
        Alert.alert("Clocked In", `Site: ${name}${result?.geoResolved?.distanceMiles != null ? ` (${result.geoResolved.distanceMiles} mi away)` : ""}.`);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Clock-in failed";
      Alert.alert("Cannot Clock In", msg);
    }
  };

  const handleClockIn = async () => {
    if (!location) {
      if (isWeb) {
        // Web preview can't use browser GPS inside the workspace iframe — let
        // the user manually pick a site whose coordinates we'll use instead.
        setShowSitePicker(true);
        return;
      }
      Alert.alert("Location Required", "We need your GPS to identify which site you're at. Please enable location and try again.");
      return;
    }
    Alert.alert("Clock In", "Start your shift now? Your location will be used to identify the site.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clock In", onPress: () => performClockIn(location.lat, location.lon) },
    ]);
  };

  const handlePickSite = (site: any) => {
    setShowSitePicker(false);
    const lat = site?.locationLat != null ? Number(site.locationLat) : null;
    const lng = site?.locationLng != null ? Number(site.locationLng) : null;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
      Alert.alert("Site Has No Coordinates", `${site?.name ?? "This site"} doesn't have a saved location yet. Add lat/lng to the site in the admin portal first.`);
      return;
    }
    setLocation({ lat, lon: lng });
    performClockIn(lat, lng, site.name);
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

      {isWeb && showSitePicker && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, marginHorizontal: 16, borderRadius: 12, borderWidth: 1, padding: 16 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { color: colors.accent }]}>PICK A SITE</Text>
            <TouchableOpacity onPress={() => setShowSitePicker(false)}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 10 }}>
            Browser GPS isn't available in this preview. Pick the site you're clocking in at:
          </Text>
          {((sitesList as any[]) ?? []).map((s: any) => (
            <TouchableOpacity
              key={s.id}
              onPress={() => handlePickSite(s)}
              style={[styles.entryCard, { backgroundColor: colors.background, borderColor: colors.border, padding: 12 }]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Feather name="map-pin" size={14} color={colors.primary} />
                <Text style={[{ color: colors.foreground, fontWeight: "600", flex: 1 }]}>{s.name}</Text>
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
              </View>
              {s.address && <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 4, marginLeft: 22 }}>{s.address}</Text>}
            </TouchableOpacity>
          ))}
          {((sitesList as any[]) ?? []).length === 0 && (
            <Text style={{ color: colors.mutedForeground, fontSize: 12, textAlign: "center", padding: 20 }}>No sites configured.</Text>
          )}
        </View>
      )}

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
