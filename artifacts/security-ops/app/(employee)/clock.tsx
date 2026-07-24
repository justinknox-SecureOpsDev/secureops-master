import React, { useState, useEffect, useRef } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, AccessibilityInfo, Modal, Animated, TextInput } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useHighlightFlash } from "@/hooks/useHighlightFlash";
import { useLocalSearchParams } from "expo-router";
import { useClockIn, useClockOut, useGetActiveTimeEntry, getGetActiveTimeEntryQueryKey, useGetTimeEntries, getGetTimeEntriesQueryKey, updateMyLocation, useGetMyClockInShifts, getGetMyClockInShiftsQueryKey, getGetEmployeeDashboardSummaryQueryKey, getGetShiftsQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Location from "expo-location";

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function EmployeeClockScreen({ hideTopPad }: { hideTopPad?: boolean } = {}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const topPad = useTopPad();
  const [elapsed, setElapsed] = useState(0);
  const [location, setLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  // In-app confirm + status. We deliberately avoid window.confirm/window.alert:
  // mobile browsers (iOS Safari especially) frequently suppress native JS
  // dialogs, which would silently abort clock-in with no feedback.
  const [confirmModal, setConfirmModal] = useState<null | {
    title: string;
    message: string;
    confirmText: string;
    destructive?: boolean;
    showCorrectionInput?: boolean;
    onConfirm: () => void;
  }>(null);
  const [correctionNote, setCorrectionNote] = useState("");
  const [statusMsg, setStatusMsg] = useState<null | { kind: "info" | "error"; text: string }>(null);

  const { data: currentEntry, isLoading: entryLoading } = useGetActiveTimeEntry({
    query: { queryKey: getGetActiveTimeEntryQueryKey() }
  });

  const { data: recentEntries } = useGetTimeEntries(
    {},
    { query: { queryKey: getGetTimeEntriesQueryKey({}) } },
  );

  // Deep-link highlight: a "forgot to clock out" tap lands here with the open
  // entry's id so we can scroll to + flash it in the recent-entries list.
  const { timeEntryId: highlightEntryId, _hlTs } =
    useLocalSearchParams<{ timeEntryId?: string; _hlTs?: string }>();
  const scrollRef = useRef<ScrollView>(null);
  const recentSectionY = useRef(0);
  const entryOffsets = useRef<Record<string, number>>({});
  const flashAnim = useHighlightFlash(
    highlightEntryId ? `${highlightEntryId}:${_hlTs ?? ""}` : null,
  );

  useEffect(() => {
    if (!highlightEntryId) return;
    const t = setTimeout(() => {
      const rel = entryOffsets.current[highlightEntryId];
      if (rel == null) return; // entry not in the recent list — leave scroll alone
      scrollRef.current?.scrollTo({ y: Math.max(0, recentSectionY.current + rel - 24), animated: true });
    }, 350);
    return () => clearTimeout(t);
  }, [highlightEntryId, _hlTs, recentEntries]);

  // networkMode "always" is critical here: clocking in/out are time-sensitive,
  // user-initiated actions that must NEVER be silently paused by React Query's
  // online detection. With the default "online" mode, a flaky/false "offline"
  // reading would pause mutateAsync indefinitely — the button spins and no
  // request is sent. "always" fires the request regardless and surfaces real
  // network failures to the catch handler so the user gets actionable feedback.
  const clockInMutation = useClockIn({ mutation: { networkMode: "always" } });
  const clockOutMutation = useClockOut({ mutation: { networkMode: "always" } });

  // Manual shift picker fallback. Needed whenever GPS is unavailable (web preview
  // blocks geolocation; native GPS can be denied/off) OR the officer's venue has
  // a Site with no saved coordinates, where geo-resolution can never match. The
  // officer taps a reserved shift; we send its shiftId so the server skips the
  // geo check AND the time entry binds to the shift (pay/bill rates resolve from
  // it, so payroll/invoicing stay clean — an ad-hoc site pick carries no rate).
  const [showShiftPicker, setShowShiftPicker] = useState(false);
  const { data: shiftsList } = useGetMyClockInShifts({
    query: { queryKey: getGetMyClockInShiftsQueryKey() },
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

  const performClockIn = async (opts: { lat?: number; lng?: number; siteId?: string; shiftId?: string; siteLabel?: string }) => {
    const { lat, lng, siteId, shiftId, siteLabel } = opts;
    try {
      const result: any = await clockInMutation.mutateAsync({
        data: {
          ...(lat != null && lng != null ? { lat, lng } : {}),
          ...(shiftId ? { shiftId } : {}),
          ...(siteId ? { siteId } : {}),
        } as any,
      });
      AccessibilityInfo.announceForAccessibility(`Clocked in${siteLabel ? ` at ${siteLabel}` : ""}. You are now on duty.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetEmployeeDashboardSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() }),
      ]);
      const name = result?.geoResolved?.siteName ?? siteLabel;
      setStatusMsg({
        kind: "info",
        text: name
          ? `Clocked in at ${name}${result?.geoResolved?.distanceMiles != null ? ` (${result.geoResolved.distanceMiles} mi away)` : ""}.`
          : "You're clocked in. You are now on duty.",
      });
    } catch (e: any) {
      const status = e?.response?.status;
      const code = e?.response?.data?.error;
      const msg = e?.response?.data?.message || e?.message || "Clock-in failed";
      // GPS is unreliable: mobile-web is geolocated from wifi/IP (often off by
      // miles) and native GPS can be denied/off. A "No Site Nearby" (422) usually
      // means the fix was wrong — NOT that the officer is actually far from their
      // post — and some venues have no saved site coordinates at all. Rather than
      // dead-ending, fall back to the manual site picker, which sends the chosen
      // siteId and lets the server skip the geo check. The `!siteLabel` guard
      // prevents a loop when the failing attempt was itself a manual pick.
      if (!siteLabel && (status === 422 || code === "No Site Nearby")) {
        setShowShiftPicker(true);
        setStatusMsg({
          kind: "info",
          text: "We couldn't match your location to a site automatically. Tap your reserved shift below to clock in.",
        });
        return;
      }
      setStatusMsg({ kind: "error", text: msg });
    }
  };

  const handleClockIn = async () => {
    setStatusMsg(null);
    if (!location) {
      // GPS unavailable/denied (web preview or native permission off) — let the
      // officer pick their reserved shift manually instead of dead-ending.
      setShowShiftPicker(true);
      return;
    }
    setConfirmModal({
      title: "Clock In",
      message: "Start your shift now? Your location will be used to identify the site.",
      confirmText: "Clock In",
      onConfirm: () => {
        setConfirmModal(null);
        performClockIn({ lat: location.lat, lng: location.lon });
      },
    });
  };

  const handlePickShift = (shift: any) => {
    setShowShiftPicker(false);
    setStatusMsg(null);
    // Send the shiftId so the server binds the time entry to this reserved shift
    // (pay/bill rates resolve from it) and skips the geo check. siteLabel doubles
    // as the loop guard in performClockIn's 422 handler.
    performClockIn({
      shiftId: shift.shiftId,
      siteLabel: shift.siteName ?? shift.title ?? "your shift",
    });
  };

  const performClockOut = async () => {
    if (!currentEntry?.id) return;
    const trimmedCorrection = correctionNote.trim();
    try {
      await clockOutMutation.mutateAsync({
        data: {
          timeEntryId: currentEntry.id,
          lat: location?.lat ?? 0,
          lng: location?.lon ?? 0,
          ...(trimmedCorrection ? { correctionNote: trimmedCorrection } : {}),
        } as any,
      });
      setCorrectionNote("");
      AccessibilityInfo.announceForAccessibility(
        trimmedCorrection
          ? "Clocked out. Your time correction request was sent to an admin."
          : "Clocked out. You are now off duty.",
      );
      // Clear the active-entry cache *immediately* so the ON-DUTY ring
      // flips to OFF DUTY without waiting for the refetch round-trip.
      queryClient.setQueryData(getGetActiveTimeEntryQueryKey(), null);
      setElapsed(0);
      setStatusMsg({ kind: "info", text: "Clocked out. You are now off duty." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetEmployeeDashboardSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetMyClockInShiftsQueryKey() }),
      ]);
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Clock-out failed";
      setStatusMsg({ kind: "error", text: msg });
    }
  };

  const handleClockOut = async () => {
    if (!currentEntry?.id) return;
    setStatusMsg(null);
    setCorrectionNote("");
    setConfirmModal({
      title: "Clock Out",
      message: "End your shift now? If your clock-in or clock-out time is wrong, add a correction note and an admin will fix it.",
      confirmText: "Clock Out",
      destructive: true,
      showCorrectionInput: true,
      onConfirm: () => {
        setConfirmModal(null);
        performClockOut();
      },
    });
  };

  return (
    <ScrollView ref={scrollRef} style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: hideTopPad ? 12 : topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Time Clock</Text>
        <TouchableOpacity
          onPress={getLocation}
          style={[styles.locBtn, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={location ? "Refresh location" : "Get location"}
          accessibilityState={{ busy: locationLoading }}
        >
          {locationLoading
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Feather name="map-pin" size={16} color={location ? colors.primary : colors.mutedForeground} />
          }
        </TouchableOpacity>
      </View>

      <View
        style={[styles.clockFace, { backgroundColor: colors.card, borderColor: isClockedIn ? colors.success : colors.border }]}
        accessible
        accessibilityLabel={isClockedIn ? `On duty for ${formatDuration(elapsed)}` : "Off duty"}
        accessibilityLiveRegion="polite"
      >
        <View style={[styles.clockRing, { borderColor: isClockedIn ? colors.success : colors.border }]}>
          <Text style={[styles.clockTime, { color: isClockedIn ? colors.success : colors.mutedForeground }]}>
            {isClockedIn ? formatDuration(elapsed) : "00:00:00"}
          </Text>
          <Text style={[styles.clockStatus, { color: isClockedIn ? colors.success : colors.mutedForeground }]}>
            {isClockedIn ? "ON DUTY" : "OFF DUTY"}
          </Text>
        </View>

        {isClockedIn && currentEntry?.clockInTime && (
          <Text style={[styles.clockInTime, { color: colors.mutedForeground }]}>
            Clocked in at {new Date(currentEntry.clockInTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}

        <View style={styles.locationRow}>
          <Feather name="map-pin" size={14} color={location ? colors.success : colors.mutedForeground} />
          <Text style={[styles.locationText, { color: location ? colors.success : colors.mutedForeground }]}>
            {location ? `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}` : "Location not available"}
          </Text>
        </View>

        {entryLoading ? (
          <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 20 }} />
        ) : (
          <TouchableOpacity
            style={[styles.mainBtn, { backgroundColor: isClockedIn ? colors.destructive : colors.success }]}
            onPress={isClockedIn ? handleClockOut : handleClockIn}
            disabled={clockInMutation.isPending || clockOutMutation.isPending}
            accessibilityRole="button"
            accessibilityLabel={isClockedIn ? "Clock out, end your shift" : "Clock in, start your shift"}
            accessibilityState={{ disabled: clockInMutation.isPending || clockOutMutation.isPending, busy: clockInMutation.isPending || clockOutMutation.isPending }}
          >
            {(clockInMutation.isPending || clockOutMutation.isPending) ? (
              <ActivityIndicator color={isClockedIn ? colors.destructiveForeground : colors.successForeground} size="large" />
            ) : (
              <>
                <Feather name={isClockedIn ? "square" : "play"} size={28} color={isClockedIn ? colors.destructiveForeground : colors.successForeground} />
                <Text style={[styles.mainBtnText, { color: isClockedIn ? colors.destructiveForeground : colors.successForeground }]}>{isClockedIn ? "CLOCK OUT" : "CLOCK IN"}</Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {!isClockedIn && !entryLoading && !showShiftPicker && (
          <TouchableOpacity
            onPress={() => { setStatusMsg(null); setShowShiftPicker(true); }}
            accessibilityRole="button"
            accessibilityLabel="Pick your reserved shift to clock in"
            style={{ marginTop: 14 }}
          >
            <Text style={{ color: colors.primary, fontSize: 13, textDecorationLine: "underline", textAlign: "center" }}>
              Location not working? Pick your shift
            </Text>
          </TouchableOpacity>
        )}

        {statusMsg && (
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.statusBanner,
              {
                backgroundColor: (statusMsg.kind === "error" ? colors.destructive : colors.success) + "20",
                borderColor: statusMsg.kind === "error" ? colors.destructive : colors.success,
              },
            ]}
          >
            <Feather
              name={statusMsg.kind === "error" ? "alert-circle" : "check-circle"}
              size={16}
              color={statusMsg.kind === "error" ? colors.destructive : colors.success}
            />
            <Text style={[styles.statusBannerText, { color: statusMsg.kind === "error" ? colors.destructive : colors.success }]}>
              {statusMsg.text}
            </Text>
          </View>
        )}
      </View>

      {showShiftPicker && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, marginHorizontal: 16, borderRadius: 12, borderWidth: 1, padding: 16 }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Text style={[styles.sectionTitle, { color: colors.accent }]}>PICK A SHIFT</Text>
            <TouchableOpacity
              onPress={() => setShowShiftPicker(false)}
              accessibilityRole="button"
              accessibilityLabel="Close shift picker"
            >
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 10 }}>
            Tap your reserved shift to clock in:
          </Text>
          {((shiftsList as any[]) ?? []).map((s: any) => (
            <TouchableOpacity
              key={s.shiftId}
              onPress={() => handlePickShift(s)}
              accessibilityRole="button"
              accessibilityLabel={`Clock in to ${s.title ?? "shift"}${s.siteName ? ` at ${s.siteName}` : ""}`}
              style={[
                styles.entryCard,
                { backgroundColor: colors.background, borderColor: colors.border, padding: 12 },
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Feather name="briefcase" size={14} color={colors.primary} />
                <Text style={[{ color: colors.foreground, fontWeight: "600", flex: 1 }]}>{s.title ?? s.siteName ?? "Shift"}</Text>
                <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
              </View>
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 4, marginLeft: 22 }}>
                {new Date(s.startTime).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                {" – "}
                {new Date(s.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {s.siteName ? ` · ${s.siteName}` : ""}
              </Text>
            </TouchableOpacity>
          ))}
          {((shiftsList as any[]) ?? []).length === 0 && (
            <Text style={{ color: colors.mutedForeground, fontSize: 12, textAlign: "center", padding: 20 }}>
              No shifts to clock into right now. You can clock in from 30 minutes before a reserved shift starts — reserve shifts in the My Shifts sub-tab.
            </Text>
          )}
        </View>
      )}

      {(recentEntries?.length ?? 0) > 0 && (
        <View
          style={styles.section}
          onLayout={(e) => { recentSectionY.current = e.nativeEvent.layout.y; }}
        >
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>RECENT TIME ENTRIES</Text>
          {recentEntries!.slice(0, 5).map((entry: any) => {
            const hrs = entry.hoursWorked ? parseFloat(entry.hoursWorked as any).toFixed(2) : null;
            const isHighlighted = highlightEntryId === entry.id;
            return (
              <Animated.View
                key={entry.id}
                onLayout={(e) => { entryOffsets.current[entry.id] = e.nativeEvent.layout.y; }}
                style={[styles.entryCard, {
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
                      <Feather name="map-pin" size={11} color={colors.success} />
                      <Text style={{ color: colors.success, fontSize: 11 }}>GPS</Text>
                    </View>
                  )}
                </View>
                {entry.notes && <Text style={[styles.entryNotes, { color: colors.mutedForeground }]}>{entry.notes}</Text>}
              </Animated.View>
            );
          })}
        </View>
      )}

      <Modal
        visible={!!confirmModal}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>{confirmModal?.title}</Text>
            <Text style={[styles.modalMessage, { color: colors.mutedForeground }]}>{confirmModal?.message}</Text>
            {confirmModal?.showCorrectionInput && (
              <TextInput
                style={[styles.correctionInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                value={correctionNote}
                onChangeText={setCorrectionNote}
                placeholder="Time correction note (optional)"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
                accessibilityLabel="Time correction note"
              />
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, { borderColor: colors.border, borderWidth: 1 }]}
                onPress={() => setConfirmModal(null)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: confirmModal?.destructive ? colors.destructive : colors.success }]}
                onPress={() => confirmModal?.onConfirm()}
                accessibilityRole="button"
                accessibilityLabel={confirmModal?.confirmText}
              >
                <Text style={[styles.modalBtnText, { color: confirmModal?.destructive ? colors.destructiveForeground : colors.successForeground }]}>{confirmModal?.confirmText}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  statusBanner: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, alignSelf: "stretch" },
  statusBannerText: { flex: 1, fontSize: 13, fontWeight: "600" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 360, borderRadius: 16, borderWidth: 1, padding: 20, gap: 8 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  modalMessage: { fontSize: 14, lineHeight: 20 },
  correctionInput: { marginTop: 12, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, minHeight: 72, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, minWidth: 96, alignItems: "center" },
  modalBtnText: { fontSize: 14, fontWeight: "700" },
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
