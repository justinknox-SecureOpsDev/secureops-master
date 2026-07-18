import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { notify } from "@/utils/confirm";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { FeatureGate } from "@/components/FeatureGate";

type Window = {
  id?: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

type SuggestedShift = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  payRate: string;
  requiredLicenseLevel: number;
  siteName: string | null;
  siteAddress: string | null;
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export default function AvailabilityScreen() {
  return (
    <FeatureGate feature="availability">
      <AvailabilityScreenInner />
    </FeatureGate>
  );
}

function AvailabilityScreenInner() {
  const colors = useColors();
  const router = useRouter();

  const [windows, setWindows] = useState<Window[]>([]);
  const [maxHours, setMaxHours] = useState<string>("");
  const [suggested, setSuggested] = useState<SuggestedShift[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [avail, sug] = await Promise.all([
        apiRequest("/me/availability"),
        apiRequest("/me/suggested-shifts").catch(() => ({ shifts: [] })),
      ]);
      setWindows(Array.isArray(avail?.windows) ? avail.windows : []);
      setMaxHours(avail?.maxWeeklyHours != null ? String(avail.maxWeeklyHours) : "");
      setSuggested(Array.isArray(sug?.shifts) ? sug.shifts : []);
    } catch (e: any) {
      notify("Could not load availability", e?.message ?? "Please try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const groupedByDay = useMemo(() => {
    const m = new Map<number, Window[]>();
    for (let d = 0; d < 7; d++) m.set(d, []);
    for (const w of windows) m.get(w.dayOfWeek)?.push(w);
    return m;
  }, [windows]);

  const addWindow = (day: number) => {
    setWindows((ws) => [...ws, { dayOfWeek: day, startTime: "09:00", endTime: "17:00" }]);
  };

  const updateWindow = (idx: number, patch: Partial<Window>) => {
    setWindows((ws) => ws.map((w, i) => (i === idx ? { ...w, ...patch } : w)));
  };

  const removeWindow = (idx: number) => {
    setWindows((ws) => ws.filter((_, i) => i !== idx));
  };

  const save = async () => {
    for (const w of windows) {
      if (!HHMM_RE.test(w.startTime) || !HHMM_RE.test(w.endTime)) {
        notify("Invalid time", "Use HH:MM 24-hour format (e.g. 09:00).");
        return;
      }
      if (w.endTime <= w.startTime) {
        notify("Invalid window", `${DAY_LABELS[w.dayOfWeek]}: end time must be after start. Overnight? Split across two days.`);
        return;
      }
    }
    const max = maxHours.trim();
    let maxWeeklyHours: number | null = null;
    if (max !== "") {
      const n = Number(max);
      if (!Number.isFinite(n) || n < 0 || n > 168) {
        notify("Invalid max hours", "Enter a number between 0 and 168, or leave blank.");
        return;
      }
      maxWeeklyHours = Math.round(n);
    }

    setSaving(true);
    try {
      await apiRequest("/me/availability", {
        method: "PUT",
        body: JSON.stringify({
          windows: windows.map((w) => ({
            dayOfWeek: w.dayOfWeek,
            startTime: w.startTime,
            endTime: w.endTime,
          })),
          maxWeeklyHours,
        }),
      });
      notify("Saved", "Your availability has been updated.");
      await load();
    } catch (e: any) {
      notify("Could not save", e?.message ?? "Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ padding: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]} accessibilityRole="header">My availability</Text>
        <View style={{ width: 30 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.accent} />}
      >
        <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
          Set the weekly hours you're available. We'll only suggest shifts that fit
          inside one of these windows. Times are local (24-hour).
        </Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>Max hours per week (optional)</Text>
          <TextInput
            value={maxHours}
            onChangeText={setMaxHours}
            placeholder="e.g. 40"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
            accessibilityLabel="Max hours per week, optional"
            accessibilityHint="Suggested shifts will skip anything that would push you over this cap"
          />
          <Text style={[styles.helperText, { color: colors.mutedForeground, marginTop: 6 }]}>
            Suggested shifts will skip anything that would push you over this cap.
          </Text>
        </View>

        {DAY_LABELS.map((label, day) => {
          const dayWindows = windows
            .map((w, idx) => ({ ...w, _idx: idx }))
            .filter((w) => w.dayOfWeek === day);
          return (
            <View key={day} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.dayHeader}>
                <Text style={[styles.dayTitle, { color: colors.foreground }]} accessibilityRole="header">{label}</Text>
                <TouchableOpacity
                  onPress={() => addWindow(day)}
                  style={[styles.addBtn, { borderColor: colors.accent }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Add availability window for ${label}`}
                >
                  <Feather name="plus" size={14} color={colors.accent} />
                  <Text style={{ color: colors.accent, fontWeight: "600", fontSize: 12 }}>Add window</Text>
                </TouchableOpacity>
              </View>
              {dayWindows.length === 0 ? (
                <Text style={[styles.helperText, { color: colors.mutedForeground }]}>Not available</Text>
              ) : (
                dayWindows.map((w) => (
                  <View key={w._idx} style={styles.windowRow}>
                    <TextInput
                      value={w.startTime}
                      onChangeText={(t) => updateWindow(w._idx, { startTime: t })}
                      placeholder="09:00"
                      placeholderTextColor={colors.mutedForeground}
                      style={[styles.timeInput, { color: colors.foreground, borderColor: colors.border }]}
                      maxLength={5}
                      accessibilityLabel={`${label} start time`}
                      accessibilityHint="24-hour format, hours and minutes"
                    />
                    <Text style={{ color: colors.mutedForeground }}>to</Text>
                    <TextInput
                      value={w.endTime}
                      onChangeText={(t) => updateWindow(w._idx, { endTime: t })}
                      placeholder="17:00"
                      placeholderTextColor={colors.mutedForeground}
                      style={[styles.timeInput, { color: colors.foreground, borderColor: colors.border }]}
                      maxLength={5}
                      accessibilityLabel={`${label} end time`}
                      accessibilityHint="24-hour format, hours and minutes"
                    />
                    <TouchableOpacity
                      onPress={() => removeWindow(w._idx)}
                      style={{ padding: 6 }}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${label} window ${w.startTime} to ${w.endTime}`}
                    >
                      <Feather name="trash-2" size={16} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </View>
          );
        })}

        <TouchableOpacity
          onPress={save}
          disabled={saving}
          style={[styles.saveBtn, { backgroundColor: colors.accent, opacity: saving ? 0.6 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel="Save availability"
          accessibilityState={{ disabled: saving, busy: saving }}
        >
          {saving ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={{ color: colors.primary, fontWeight: "700" }}>Save availability</Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.sectionHeader, { color: colors.foreground }]} accessibilityRole="header">Suggested shifts</Text>
        <Text style={[styles.helperText, { color: colors.mutedForeground, marginBottom: 8 }]}>
          Open shifts in the next 14 days that fit your windows and your license.
        </Text>

        {(suggested ?? []).length === 0 ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
              {windows.length === 0
                ? "Add at least one availability window to see suggestions."
                : "Nothing matches right now — check the Shifts tab for the full list."}
            </Text>
          </View>
        ) : (
          suggested!.map((s) => (
            <TouchableOpacity
              key={s.id}
              onPress={() => router.push("/(employee)/shifts" as any)}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={`${s.title}${s.siteName ? `, ${s.siteName}` : ""}, ${fmtDate(s.startTime)}, level ${s.requiredLicenseLevel} required, $${Number(s.payRate).toFixed(2)} per hour`}
              accessibilityHint="Opens the Shifts tab to claim"
            >
              <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 14 }}>{s.title}</Text>
              {s.siteName ? (
                <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>{s.siteName}</Text>
              ) : null}
              <Text style={{ color: colors.foreground, fontSize: 13, marginTop: 6 }}>
                {fmtDate(s.startTime)} → {new Date(s.endTime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </Text>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
                <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                  L{s.requiredLicenseLevel} required
                </Text>
                <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700" }}>
                  ${Number(s.payRate).toFixed(2)}/hr
                </Text>
              </View>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 16, fontWeight: "700" },
  helperText: { fontSize: 12, lineHeight: 16 },
  card: {
    borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 12,
  },
  cardLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  input: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: Platform.OS === "ios" ? 10 : 6,
    fontSize: 14,
  },
  dayHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  dayTitle: { fontSize: 14, fontWeight: "700" },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
  },
  windowRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  timeInput: {
    borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6,
    fontSize: 14, width: 70, textAlign: "center",
  },
  saveBtn: {
    height: 46, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 16,
  },
  sectionHeader: { fontSize: 15, fontWeight: "700", marginTop: 24, marginBottom: 4 },
});
