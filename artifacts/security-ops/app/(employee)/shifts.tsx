import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { confirmAction, notify } from "@/utils/confirm";
import {
  useGetShifts, getGetShiftsQueryKey,
  useGetMe, getGetMeQueryKey,
  useGetEmployee, getGetEmployeeQueryKey,
  claimShift, useUpdateShiftAssignment,
  useClockIn, useGetActiveTimeEntry, getGetActiveTimeEntryQueryKey, getGetTimeEntriesQueryKey,
  getGetEmployeeDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import * as Location from "expo-location";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import { LicenseLevelBadge, levelLabel } from "@/components/LicenseLevelBadge";
import { SwapRequestModal } from "@/components/SwapRequestModal";
import { useRouter } from "expo-router";

const FILTERS = ["available", "upcoming", "active", "completed"] as const;

export default function EmployeeShiftsScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<typeof FILTERS[number]>("available");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [swapTarget, setSwapTarget] = useState<{ assignmentId: string; title: string } | null>(null);
  const topPad = useTopPad();

  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const myUserId = (me as any)?.id as string | undefined;
  const { data: myEmployee } = useGetEmployee(myUserId!, {
    query: { queryKey: getGetEmployeeQueryKey(myUserId!), enabled: !!myUserId },
  });
  const myMaxLevel = (myEmployee as any)?.maxLicenseLevel as number | null | undefined;

  const statusParam = filter === "available" ? "upcoming" : filter;
  const { data: allShifts, isLoading, error, refetch } = useGetShifts(
    { status: statusParam as any },
    { query: { queryKey: getGetShiftsQueryKey({ status: statusParam as any }) } },
  );

  const updateAssignment = useUpdateShiftAssignment();
  const clockInMutation = useClockIn();
  const { data: activeEntry } = useGetActiveTimeEntry({
    query: { queryKey: getGetActiveTimeEntryQueryKey() },
  });
  const isClockedInElsewhere = !!(activeEntry as any)?.id;

  const nowMs = Date.now();
  const shifts = (allShifts ?? []).filter((s: any) => {
    const isAssigned = (s.assignments ?? []).some((a: any) => a.employeeId === myUserId);
    // Hide shifts whose end time has already passed from "available" and "upcoming"
    // (they're stale slots nobody clocked into).
    if (filter === "available" || filter === "upcoming") {
      const endMs = s.endTime ? new Date(s.endTime).getTime() : 0;
      if (endMs && endMs < nowMs) return false;
    }
    if (filter === "available") return !isAssigned;
    return isAssigned;
  });

  const myAssignmentFor = (shift: any) =>
    (shift.assignments ?? []).find((a: any) => a.employeeId === myUserId);

  const statusColor: Record<string, string> = { upcoming: colors.primary, active: "#22c55e", completed: colors.mutedForeground };

  const handleClaim = async (shift: any) => {
    const ok = await confirmAction({
      title: "Reserve This Shift",
      message: `${shift.title} @ ${shift.clientName}\n\nReserving books you onto this shift. You can release it later if you can't make it.`,
      confirmText: "Reserve",
    });
    if (!ok) return;
    setBusyId(shift.id);
    try {
      await claimShift(shift.id);
      await queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
      setFilter("upcoming");
      notify("Shift Reserved", "You're booked. See it under 'Upcoming'.");
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Could not reserve this shift.";
      notify("Reservation Failed", msg);
    } finally {
      setBusyId(null);
    }
  };

  const handleAccept = async (shift: any, assignmentId: string) => {
    setBusyId(shift.id);
    try {
      await updateAssignment.mutateAsync({ id: shift.id, assignmentId, data: { status: "accepted" } });
      await queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
    } catch (e: any) {
      notify("Failed", e?.response?.data?.message || e?.message || "Could not accept shift.");
    } finally {
      setBusyId(null);
    }
  };

  const handleClockInToShift = async (shift: any) => {
    if (isClockedInElsewhere) {
      notify("Already Clocked In", "You're already clocked in. Clock out first from the Clock tab.");
      return;
    }
    const ok = await confirmAction({
      title: "Clock In Now?",
      message: `Start your shift "${shift.title}"?\n\nYour time will be tracked against this specific shift for payroll and invoicing.`,
      confirmText: "Clock In",
    });
    if (!ok) return;
    setBusyId(shift.id);
    let lat = 0;
    let lng = 0;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === "granted") {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        lat = loc.coords.latitude;
        lng = loc.coords.longitude;
      }
    } catch { /* GPS optional when shiftId is provided */ }
    try {
      await clockInMutation.mutateAsync({ data: { shiftId: shift.id, lat, lng } as any });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetActiveTimeEntryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetEmployeeDashboardSummaryQueryKey() }),
      ]);
      notify("Clocked In", `You're on duty for ${shift.title}. Open the Clock tab to clock out when finished.`);
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Could not clock in.";
      notify("Clock-In Failed", msg);
    } finally {
      setBusyId(null);
    }
  };

  const handleDecline = async (shift: any, assignmentId: string) => {
    const ok = await confirmAction({
      title: "Release This Shift?",
      message: `Releasing ${shift.title} will free the slot for another officer. This will be visible to admin.`,
      confirmText: "Release",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(shift.id);
    try {
      await updateAssignment.mutateAsync({ id: shift.id, assignmentId, data: { status: "declined" } });
      await queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
    } catch (e: any) {
      notify("Failed", e?.response?.data?.message || e?.message || "Could not release shift.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Shifts</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
            <Feather name="award" size={11} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
              Your clearance: {levelLabel(myMaxLevel ?? null)}
            </Text>
          </View>
        </View>
      </View>

      {!myMaxLevel && myEmployee && (
        <TouchableOpacity
          onPress={() => router.push("/edit-profile")}
          style={{
            margin: 12, padding: 12, borderRadius: 10, borderWidth: 1,
            borderColor: colors.accent, backgroundColor: colors.accent + "15",
            flexDirection: "row", alignItems: "center", gap: 10,
          }}
        >
          <Feather name="alert-triangle" size={18} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.accent, fontWeight: "700", fontSize: 13 }}>
              No active TX security licence on file
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 2 }}>
              You can't claim shifts until admin verifies your licence. Tap to upload a photo of your card or contact admin.
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      )}

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
          data={shifts}
          keyExtractor={(item: any) => item.id}
          scrollEnabled={shifts.length > 0}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name={filter === "available" ? "inbox" : "calendar"} size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {filter === "available" ? "No open shifts you qualify for right now" : `No ${filter} shifts`}
              </Text>
            </View>
          }
          renderItem={({ item }: { item: any }) => {
            const sc = statusColor[item.status] || colors.mutedForeground;
            const duration = ((new Date(item.endTime).getTime() - new Date(item.startTime).getTime()) / 3600000).toFixed(1);
            const start = new Date(item.startTime);
            const filled = (item.assignments ?? []).length;
            const isAvailable = filter === "available";
            const myAssign = myAssignmentFor(item);
            const isPending = myAssign?.status === "pending";
            const isAccepted = myAssign?.status === "accepted";
            const busy = busyId === item.id;
            return (
              <View style={[styles.card, {
                backgroundColor: colors.card,
                borderColor: isPending ? colors.accent : colors.border,
                borderLeftColor: sc,
                borderLeftWidth: 3,
              }]}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.shiftTitle, { color: colors.foreground }]}>{item.title}</Text>
                    <Text style={[styles.clientName, { color: colors.primary }]}>{item.clientName}</Text>
                  </View>
                  <View style={[styles.durationBadge, { backgroundColor: sc + "20", borderColor: sc }]}>
                    <Text style={[styles.durationText, { color: sc }]}>{duration}h</Text>
                  </View>
                </View>

                {isPending && (
                  <View style={[styles.statusBanner, { backgroundColor: colors.accent + "20", borderColor: colors.accent }]}>
                    <Feather name="alert-circle" size={14} color={colors.accent} />
                    <Text style={[styles.statusBannerText, { color: colors.accent }]}>Awaiting your acceptance</Text>
                  </View>
                )}
                {isAccepted && (
                  <View style={[styles.statusBanner, { backgroundColor: "#22c55e20", borderColor: "#22c55e" }]}>
                    <Feather name="check-circle" size={14} color="#22c55e" />
                    <Text style={[styles.statusBannerText, { color: "#22c55e" }]}>Confirmed — you're committed to this shift</Text>
                  </View>
                )}

                <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <LicenseLevelBadge level={item.requiredLicenseLevel} size="sm" />
                  <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
                    {filled}/{item.headcount} filled
                  </Text>
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
                  <Text style={[styles.rateText, { color: colors.primary }]}>${parseFloat(item.payRate ?? item.hourlyRate ?? "0").toFixed(2)}/hr</Text>
                  <Text style={[styles.earnText, { color: colors.mutedForeground }]}>
                    ≈ ${(parseFloat(item.payRate ?? item.hourlyRate ?? "0") * parseFloat(duration)).toFixed(2)} total
                  </Text>
                </View>

                {item.notes && (
                  <View style={[styles.notesBox, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Feather name="file-text" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.notesText, { color: colors.mutedForeground }]}>{item.notes}</Text>
                  </View>
                )}

                {isAvailable && (
                  <TouchableOpacity
                    style={[styles.claimBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
                    onPress={() => handleClaim(item)}
                    disabled={busy}
                  >
                    {busy ? <ActivityIndicator color={colors.primaryForeground} /> : (
                      <>
                        <Feather name="bookmark" size={16} color={colors.primaryForeground} />
                        <Text style={[styles.claimText, { color: colors.primaryForeground }]}>Reserve Slot</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}

                {isPending && (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TouchableOpacity
                      style={[styles.acceptBtn, { backgroundColor: "#22c55e", opacity: busy ? 0.6 : 1 }]}
                      onPress={() => handleAccept(item, myAssign!.id)}
                      disabled={busy}
                    >
                      {busy ? <ActivityIndicator color="#fff" /> : (
                        <>
                          <Feather name="check" size={16} color="#fff" />
                          <Text style={[styles.acceptText, { color: "#fff" }]}>Accept</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.declineBtn, { borderColor: colors.destructive, opacity: busy ? 0.6 : 1 }]}
                      onPress={() => handleDecline(item, myAssign!.id)}
                      disabled={busy}
                    >
                      <Feather name="x" size={16} color={colors.destructive} />
                      <Text style={[styles.declineText, { color: colors.destructive }]}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {isAccepted && myAssign && (() => {
                  // Show "Clock In Now" from 1 hour before start through end of
                  // shift; outside that window only the Release button shows.
                  const now = Date.now();
                  const startMs = new Date(item.startTime).getTime();
                  const endMs = new Date(item.endTime).getTime();
                  // True when *this* user is currently clocked in to *this* exact shift.
                  const clockedInToThisShift =
                    !!(activeEntry as any)?.id && (activeEntry as any)?.shiftId === item.id;
                  const canClockIn =
                    now >= startMs - 60 * 60 * 1000 &&
                    now <= endMs &&
                    item.status !== "completed" &&
                    item.status !== "cancelled" &&
                    !isClockedInElsewhere;
                  // Once on duty, you can't release this shift — you have to clock
                  // out first. Also hide once the shift is completed/cancelled.
                  const canRelease =
                    !clockedInToThisShift &&
                    item.status !== "completed" &&
                    item.status !== "cancelled";
                  return (
                    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                      {clockedInToThisShift && (
                        <View style={[styles.statusBanner, { backgroundColor: "#22c55e20", borderColor: "#22c55e", flex: 1 }]}>
                          <Feather name="clock" size={14} color="#22c55e" />
                          <Text style={[styles.statusBannerText, { color: "#22c55e" }]}>On duty — clock out from the Clock tab</Text>
                        </View>
                      )}
                      {canClockIn && !clockedInToThisShift && (
                        <TouchableOpacity
                          style={[styles.acceptBtn, { backgroundColor: "#22c55e", opacity: busy ? 0.6 : 1 }]}
                          onPress={() => handleClockInToShift(item)}
                          disabled={busy}
                        >
                          {busy ? <ActivityIndicator color="#fff" /> : (
                            <>
                              <Feather name="play" size={16} color="#fff" />
                              <Text style={[styles.acceptText, { color: "#fff" }]}>Clock In Now</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      )}
                      {canRelease && (
                        <TouchableOpacity
                          style={[styles.declineBtn, { borderColor: colors.destructive, opacity: busy ? 0.6 : 1 }]}
                          onPress={() => handleDecline(item, myAssign.id)}
                          disabled={busy}
                        >
                          {busy && !canClockIn ? <ActivityIndicator color={colors.destructive} /> : (
                            <>
                              <Feather name="x" size={14} color={colors.destructive} />
                              <Text style={[styles.declineText, { color: colors.destructive }]}>Release Shift</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      )}
                      {now < startMs && !clockedInToThisShift && (
                        <TouchableOpacity
                          style={[styles.declineBtn, { borderColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
                          onPress={() => setSwapTarget({ assignmentId: myAssign.id, title: `${item.title} @ ${item.clientName}` })}
                          disabled={busy}
                        >
                          <Feather name="repeat" size={14} color={colors.primary} />
                          <Text style={[styles.declineText, { color: colors.primary }]}>Request Swap</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })()}
              </View>
            );
          }}
        />
      )}
      {swapTarget && myUserId && (
        <SwapRequestModal
          visible={!!swapTarget}
          onClose={() => setSwapTarget(null)}
          onSubmitted={() => router.push("/swap-requests" as any)}
          assignmentId={swapTarget.assignmentId}
          shiftTitle={swapTarget.title}
          myUserId={myUserId}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, alignItems: "center" },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, flexWrap: "wrap" },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  shiftTitle: { fontSize: 15, fontWeight: "700" },
  clientName: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  durationBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  durationText: { fontSize: 13, fontWeight: "700" },
  statusBanner: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderRadius: 6, borderWidth: 1 },
  statusBannerText: { fontSize: 12, fontWeight: "700", flex: 1 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  detailText: { fontSize: 12, flex: 1 },
  timeBlock: { flexDirection: "row", borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  timeItem: { flex: 1, alignItems: "center", paddingVertical: 10 },
  timeLabel: { fontSize: 9, fontWeight: "700", letterSpacing: 1, marginBottom: 3 },
  timeValue: { fontSize: 14, fontWeight: "600" },
  timeDivider: { width: 1 },
  rateRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rateText: { fontSize: 13, fontWeight: "700" },
  earnText: { fontSize: 12, flex: 1 },
  notesBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: 6, borderWidth: 1 },
  notesText: { fontSize: 12, flex: 1, lineHeight: 16 },
  emptyText: { marginTop: 12, fontSize: 14, textAlign: "center" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  claimBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 8, marginTop: 4 },
  claimText: { fontSize: 14, fontWeight: "700" },
  acceptBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 8 },
  acceptText: { fontSize: 14, fontWeight: "700" },
  declineBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 8, borderWidth: 1.5 },
  declineText: { fontSize: 14, fontWeight: "700" },
});
