import React, { useEffect, useState, useCallback } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";

type CardEntry = {
  id: string;
  clockInTime: string;
  clockOutTime?: string | null;
  hoursWorked?: number | null;
  approvalStatus: "pending" | "approved" | "rejected";
  siteName?: string | null;
  shiftTitle?: string | null;
  open: boolean;
};

type CardDay = { date: string; entries: CardEntry[]; totalHours: number };

type TimeCard = {
  employeeId: string;
  employeeName?: string;
  timezone: string;
  weekStart: string;
  weekEnd: string;
  prevWeekStart: string;
  nextWeekStart: string;
  days: CardDay[];
  totalHours: number;
  approvedHours: number;
  pendingHours: number;
};

const APPROVAL_LABEL: Record<CardEntry["approvalStatus"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

function approvalColor(s: CardEntry["approvalStatus"], colors: ReturnType<typeof useColors>): string {
  if (s === "approved") return "#22c55e";
  if (s === "rejected") return colors.destructive;
  return colors.mutedForeground;
}

function fmtTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

function fmtDay(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtRange(a: string, b: string): string {
  const d1 = new Date(a + "T00:00:00");
  const d2 = new Date(b + "T00:00:00");
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${d1.toLocaleDateString("en-US", opts)} – ${d2.toLocaleDateString("en-US", opts)}, ${d2.getFullYear()}`;
}

function fmtHours(n: number): string {
  return `${n.toFixed(2)} h`;
}

export default function TimeCardScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const [week, setWeek] = useState<string | null>(null); // null = current week
  const [card, setCard] = useState<TimeCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (weekStart: string | null) => {
    try {
      setError(null);
      const qs = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : "";
      const r = await apiRequest(`/time-entries/time-card${qs}`);
      setCard(r as TimeCard);
    } catch (e) {
      setError((e as Error).message ?? "Could not load time card");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load(week);
  }, [week, load]);

  const todayIso = card ? new Date().toLocaleDateString("en-CA", { timeZone: card.timezone }) : null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={[styles.container, { backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(week); }}
            tintColor={colors.primary}
          />
        }
      >
        <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="chevron-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">My Time Card</Text>
          <View style={{ width: 32 }} />
        </View>

        {/* Week navigation */}
        <View style={[styles.weekNav, { borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => card && setWeek(card.prevWeekStart)}
            style={styles.weekBtn}
            disabled={!card}
            accessibilityRole="button"
            accessibilityLabel="Previous week"
          >
            <Feather name="chevron-left" size={20} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setWeek(null)}
            accessibilityRole="button"
            accessibilityLabel={card ? `Week of ${fmtRange(card.weekStart, card.weekEnd)}. Tap to jump to the current week.` : "Loading week"}
            style={{ flex: 1, alignItems: "center" }}
          >
            <Text style={[styles.weekLabel, { color: colors.foreground }]}>
              {card ? fmtRange(card.weekStart, card.weekEnd) : "—"}
            </Text>
            <Text style={[styles.weekSub, { color: colors.mutedForeground }]}>Mon – Sun · tap for this week</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => card && setWeek(card.nextWeekStart)}
            style={styles.weekBtn}
            disabled={!card}
            accessibilityRole="button"
            accessibilityLabel="Next week"
          >
            <Feather name="chevron-right" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
        ) : error ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.destructive, fontSize: 14 }}>{error}</Text>
          </View>
        ) : card ? (
          <>
            {/* Weekly summary */}
            <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.summaryRow}>
                <View style={styles.summaryCell}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>WEEK TOTAL</Text>
                  <Text style={[styles.summaryValue, { color: colors.accent }]}>{fmtHours(card.totalHours)}</Text>
                </View>
                <View style={[styles.summaryCell, { borderLeftColor: colors.border, borderLeftWidth: 1 }]}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>APPROVED</Text>
                  <Text style={[styles.summaryValue, { color: colors.foreground }]}>{fmtHours(card.approvedHours)}</Text>
                </View>
                <View style={[styles.summaryCell, { borderLeftColor: colors.border, borderLeftWidth: 1 }]}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>PENDING</Text>
                  <Text style={[styles.summaryValue, { color: colors.foreground }]}>{fmtHours(card.pendingHours)}</Text>
                </View>
              </View>
            </View>

            {card.totalHours === 0 && card.days.every((d) => d.entries.length === 0) ? (
              <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, alignItems: "center" }]}>
                <Feather name="clock" size={32} color={colors.mutedForeground} />
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No hours this week</Text>
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  Clock in from the My Work tab and your hours will appear here.
                </Text>
              </View>
            ) : (
              card.days.map((day) => {
                const isToday = day.date === todayIso;
                return (
                  <View
                    key={day.date}
                    style={[styles.dayCard, { backgroundColor: colors.card, borderColor: isToday ? colors.primary : colors.border }]}
                  >
                    <View style={[styles.dayHead, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.dayTitle, { color: colors.foreground }]} accessibilityRole="header">
                        {fmtDay(day.date)}{isToday ? " · Today" : ""}
                      </Text>
                      <Text style={[styles.dayTotal, { color: day.totalHours > 0 ? colors.accent : colors.mutedForeground }]}>
                        {fmtHours(day.totalHours)}
                      </Text>
                    </View>
                    {day.entries.length === 0 ? (
                      <Text style={[styles.noEntries, { color: colors.mutedForeground }]}>No entries</Text>
                    ) : (
                      day.entries.map((e) => {
                        const ac = approvalColor(e.approvalStatus, colors);
                        const label = `${fmtTime(e.clockInTime, card.timezone)} to ${e.open ? "now, still clocked in" : e.clockOutTime ? fmtTime(e.clockOutTime, card.timezone) : "unknown"}${e.siteName ? ` at ${e.siteName}` : ""}. ${e.open ? "In progress." : `${(e.hoursWorked ?? 0).toFixed(2)} hours.`} ${APPROVAL_LABEL[e.approvalStatus]}.`;
                        return (
                          <View key={e.id} style={[styles.entryRow, { borderBottomColor: colors.border }]} accessible accessibilityLabel={label}>
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.entryTimes, { color: colors.foreground }]}>
                                {fmtTime(e.clockInTime, card.timezone)} → {e.open ? "now" : e.clockOutTime ? fmtTime(e.clockOutTime, card.timezone) : "—"}
                              </Text>
                              {(e.siteName || e.shiftTitle) ? (
                                <Text style={[styles.entrySite, { color: colors.mutedForeground }]} numberOfLines={1}>
                                  {e.siteName ?? e.shiftTitle}
                                </Text>
                              ) : null}
                            </View>
                            <View style={{ alignItems: "flex-end", gap: 4 }}>
                              <Text style={[styles.entryHours, { color: colors.foreground }]}>
                                {e.open ? "In progress" : fmtHours(e.hoursWorked ?? 0)}
                              </Text>
                              <View style={[styles.statusPill, { backgroundColor: ac + "20", borderColor: ac + "60" }]}>
                                <Text style={[styles.statusPillText, { color: ac }]}>{APPROVAL_LABEL[e.approvalStatus]}</Text>
                              </View>
                            </View>
                          </View>
                        );
                      })
                    )}
                  </View>
                );
              })
            )}

            <Text style={[styles.tzNote, { color: colors.mutedForeground }]}>
              Days follow the company timezone ({card.timezone}). Rejected entries are shown but not counted in totals.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, justifyContent: "space-between" },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  weekNav: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 10, borderBottomWidth: 1 },
  weekBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  weekLabel: { fontSize: 15, fontWeight: "700" },
  weekSub: { fontSize: 10, marginTop: 2 },
  section: { margin: 16, padding: 18, borderRadius: 12, borderWidth: 1, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", marginTop: 12 },
  emptyText: { fontSize: 13, textAlign: "center", marginTop: 4, lineHeight: 18 },
  summaryCard: { margin: 16, marginBottom: 8, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  summaryRow: { flexDirection: "row" },
  summaryCell: { flex: 1, padding: 14, gap: 4, alignItems: "center" },
  summaryLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  summaryValue: { fontSize: 17, fontWeight: "700" },
  dayCard: { marginHorizontal: 16, marginTop: 8, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  dayHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottomWidth: 1 },
  dayTitle: { fontSize: 13, fontWeight: "700" },
  dayTotal: { fontSize: 13, fontWeight: "700" },
  noEntries: { fontSize: 12, padding: 12 },
  entryRow: { flexDirection: "row", alignItems: "center", padding: 12, gap: 10, borderBottomWidth: 1 },
  entryTimes: { fontSize: 14, fontWeight: "600" },
  entrySite: { fontSize: 12, marginTop: 2 },
  entryHours: { fontSize: 13, fontWeight: "700" },
  statusPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  statusPillText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  tzNote: { fontSize: 11, textAlign: "center", marginTop: 14, marginHorizontal: 24, lineHeight: 16 },
});
