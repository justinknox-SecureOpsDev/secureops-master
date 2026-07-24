import React, { useState, useRef, useEffect } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, SectionList, TouchableOpacity, ActivityIndicator, Animated } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useHighlightFlash } from "@/hooks/useHighlightFlash";
import { confirmAction, notify } from "@/utils/confirm";
import { COPY_ALREADY_CLOCKED_IN, COPY_CLOCKED_IN_SUCCESS, COPY_ON_DUTY_BANNER } from "@/constants/userCopy";
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
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";

const FILTERS = ["available", "upcoming", "active", "completed"] as const;

export default function EmployeeShiftsScreen({ hideTopPad }: { hideTopPad?: boolean } = {}) {
  const colors = useColors();
  const router = useRouter();
  // Site Managers keep the "no financial info" invariant even in the employee
  // experience: hide per-shift pay/earnings on their own My Shifts list.
  const { user } = useAuth();
  const isSiteManager = user?.role === "site_manager";
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<typeof FILTERS[number]>("available");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [swapTarget, setSwapTarget] = useState<{ assignmentId: string; title: string } | null>(null);
  const topPad = useTopPad();

  // Deep-link highlight: a notification tap can land here with a shiftId (+ a
  // filter hint and per-tap nonce) so we jump to the right tab, scroll to the
  // exact shift and flash it. Missing/stale ids degrade to the plain list.
  const { shiftId: highlightShiftId, filter: filterParam, _hlTs } =
    useLocalSearchParams<{ shiftId?: string; filter?: string; _hlTs?: string }>();
  const sectionListRef = useRef<SectionList<any>>(null);
  const flashAnim = useHighlightFlash(
    highlightShiftId ? `${highlightShiftId}:${_hlTs ?? ""}` : null,
  );

  // Honour the filter hint from the notification so the targeted shift's tab is
  // the one actually showing before we try to scroll to it.
  useEffect(() => {
    if (filterParam && (FILTERS as readonly string[]).includes(filterParam)) {
      setFilter(filterParam as typeof FILTERS[number]);
    }
  }, [filterParam, _hlTs]);

  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const myUserId = (me as any)?.id as string | undefined;
  const { data: myEmployee } = useGetEmployee(myUserId!, {
    query: { queryKey: getGetEmployeeQueryKey(myUserId!), enabled: !!myUserId },
  });
  const myMaxLevel = (myEmployee as any)?.maxLicenseLevel as number | null | undefined;
  const myPosition = (myEmployee as any)?.position as string | undefined;
  const isSupportStaff = myPosition === "support_staff";
  // Effective clearance: support staff are cleared for level-1 support shifts
  // even without a licence; licensed officers keep their licence level.
  const myEffectiveLevel = myMaxLevel ?? (isSupportStaff ? 1 : null);

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
  const FAR_MILES = 50;
  const shiftsUnsorted = (allShifts ?? []).filter((s: any) => {
    const isAssigned = (s.assignments ?? []).some((a: any) => a.employeeId === myUserId);
    if (filter === "available") {
      // Available is forward-looking: only show shifts that haven't started yet
      // (you can't reserve a slot that's already underway or finished).
      const startMs = s.startTime ? new Date(s.startTime).getTime() : 0;
      if (startMs && startMs < nowMs) return false;
      return !isAssigned;
    }
    if (filter === "upcoming") {
      // Hide my assigned shifts whose end time has already passed (stale slots).
      const endMs = s.endTime ? new Date(s.endTime).getTime() : 0;
      if (endMs && endMs < nowMs) return false;
    }
    return isAssigned;
  });
  // On the "available" tab, surface shifts within 50 miles of the officer's
  // home address first (nearest-first), then shifts farther than 50 mi
  // (also nearest-first), then shifts with no distance on file (no site
  // coords or no home coords yet) at the bottom in original order.
  const shifts = filter === "available"
    ? [...shiftsUnsorted].sort((a: any, b: any) => {
        const da = typeof a.distanceMilesFromHome === "number" ? a.distanceMilesFromHome : null;
        const db = typeof b.distanceMilesFromHome === "number" ? b.distanceMilesFromHome : null;
        // Unknown distances last
        if (da == null && db == null) return 0;
        if (da == null) return 1;
        if (db == null) return -1;
        const aBucket = da < FAR_MILES ? 0 : 1;
        const bBucket = db < FAR_MILES ? 0 : 1;
        if (aBucket !== bBucket) return aBucket - bBucket;
        return da - db;
      })
    : shiftsUnsorted;

  const dayKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const dayLabel = (d: Date) => {
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (dayKey(d) === dayKey(today)) return "Today";
    if (dayKey(d) === dayKey(tomorrow)) return "Tomorrow";
    return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
  };

  // Group shifts by day so the list reads as "Today / Tomorrow / <date>"
  // sections instead of one long confusing scroll. Sections are ordered
  // chronologically; within a day, "available" keeps the nearest-first order
  // already applied above, everything else sorts by start time.
  const sections = React.useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const s of shifts) {
      const k = dayKey(new Date(s.startTime));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, items]) => ({
        key: k,
        title: dayLabel(new Date(items[0].startTime)),
        data: filter === "available"
          ? items
          : [...items].sort(
              (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
            ),
      }));
  }, [shifts, filter]);

  // Once the right tab's data is in, scroll the targeted shift into view. Runs
  // on a short delay so the SectionList has laid out its rows; silently no-ops
  // when the shift isn't in the current list (stale / wrong filter).
  useEffect(() => {
    if (!highlightShiftId) return;
    let sectionIndex = -1;
    let itemIndex = -1;
    sections.forEach((s, sIdx) => {
      const idx = s.data.findIndex((it: any) => it.id === highlightShiftId);
      if (idx >= 0) { sectionIndex = sIdx; itemIndex = idx; }
    });
    if (sectionIndex < 0) return;
    const t = setTimeout(() => {
      try {
        sectionListRef.current?.scrollToLocation({
          sectionIndex, itemIndex, viewPosition: 0.3, animated: true,
        });
      } catch { /* layout not ready / out of range — leave list as-is */ }
    }, 350);
    return () => clearTimeout(t);
  }, [highlightShiftId, _hlTs, sections]);

  const myAssignmentFor = (shift: any) =>
    (shift.assignments ?? []).find((a: any) => a.employeeId === myUserId);

  const statusColor: Record<string, string> = { upcoming: colors.primary, active: colors.success, completed: colors.mutedForeground };

  const handleClaim = async (shift: any) => {
    const dist = typeof shift.distanceMilesFromHome === "number" ? shift.distanceMilesFromHome : null;
    const isFar = dist != null && dist >= FAR_MILES;
    const ok = await confirmAction({
      title: isFar ? "This Shift Is Far From Home" : "Request This Shift",
      message: isFar
        ? `${shift.title} @ ${shift.clientName}\n\nThis site is about ${Math.round(dist!)} miles from your home address. Make sure you can get there for the start time.\n\nRequesting holds the slot and sends it to an admin for approval. You'll be notified once it's confirmed.`
        : `${shift.title} @ ${shift.clientName}${dist != null ? `\n\nAbout ${Math.round(dist)} mi from home.` : ""}\n\nRequesting holds the slot and sends it to an admin for approval. You'll be notified once it's confirmed.`,
      confirmText: isFar ? `Request (${Math.round(dist!)} mi)` : "Request",
      destructive: isFar,
    });
    if (!ok) return;
    setBusyId(shift.id);
    try {
      await claimShift(shift.id);
      await queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
      setFilter("upcoming");
      notify("Request Submitted", "Your request is awaiting admin approval. See it under 'Upcoming'.");
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Could not request this shift.";
      notify("Request Failed", msg);
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
      notify("Already Clocked In", COPY_ALREADY_CLOCKED_IN);
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
      notify("Clocked In", COPY_CLOCKED_IN_SUCCESS(shift.title));
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
      <View style={[styles.topBar, { paddingTop: hideTopPad ? 12 : topPad + 12, borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Shifts</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
            <Feather name="award" size={11} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
              Your clearance: {levelLabel(myEffectiveLevel)}
            </Text>
          </View>
        </View>
      </View>

      {!myMaxLevel && !isSupportStaff && myEmployee && (
        <TouchableOpacity
          onPress={() => router.push("/edit-profile")}
          accessibilityRole="button"
          accessibilityLabel="No active TX security licence on file. You can't claim shifts until admin verifies your licence. Tap to upload a photo of your card or contact admin."
          accessibilityHint="Opens your profile to upload a licence"
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

      <View style={styles.filterRow} accessibilityRole="tablist">
        {FILTERS.map((f) => {
          const selected = filter === f;
          const fLabel = f.charAt(0).toUpperCase() + f.slice(1);
          return (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primary + "20" : "transparent" }]}
              onPress={() => setFilter(f)}
              accessibilityRole="tab"
              accessibilityLabel={`${fLabel} shifts`}
              accessibilityState={{ selected }}
            >
              <Text style={[styles.filterText, { color: selected ? colors.primary : colors.mutedForeground }]}>{fLabel}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load shifts</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Retry loading shifts"><Text style={{ color: colors.primary }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <SectionList
          ref={sectionListRef}
          sections={sections}
          keyExtractor={(item: any) => item.id}
          scrollEnabled={shifts.length > 0}
          stickySectionHeadersEnabled={false}
          onScrollToIndexFailed={() => { /* row not measured yet — ignore */ }}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          renderSectionHeader={({ section }: { section: any }) => (
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionHeaderText, { color: colors.foreground }]}>{section.title}</Text>
              <View style={[styles.sectionCount, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.sectionCountText, { color: colors.mutedForeground }]}>
                  {section.data.length} shift{section.data.length === 1 ? "" : "s"}
                </Text>
              </View>
            </View>
          )}
          renderSectionFooter={() => <View style={{ height: 16 }} />}
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
            const isPendingApproval = myAssign?.status === "pending_approval";
            const accentBorder = isPending || isPendingApproval;
            const busy = busyId === item.id;
            const isHighlighted = highlightShiftId === item.id;
            return (
              <Animated.View style={[styles.card, {
                backgroundColor: isHighlighted
                  ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.card, colors.primary + "26"] })
                  : colors.card,
                borderColor: isHighlighted
                  ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [accentBorder ? colors.accent : colors.border, colors.primary] })
                  : (accentBorder ? colors.accent : colors.border),
                borderWidth: isHighlighted
                  ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2] })
                  : 1,
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
                {isPendingApproval && (
                  <View style={[styles.statusBanner, { backgroundColor: colors.accent + "20", borderColor: colors.accent }]}>
                    <Feather name="clock" size={14} color={colors.accent} />
                    <Text style={[styles.statusBannerText, { color: colors.accent }]}>Requested — awaiting admin approval</Text>
                  </View>
                )}
                {isAccepted && (
                  <View style={[styles.statusBanner, { backgroundColor: colors.success + "20", borderColor: colors.success }]}>
                    <Feather name="check-circle" size={14} color={colors.success} />
                    <Text style={[styles.statusBannerText, { color: colors.success }]}>Confirmed — you're committed to this shift</Text>
                  </View>
                )}

                <View style={styles.metaRow}>
                  <LicenseLevelBadge level={item.requiredLicenseLevel} size="sm" />
                  <View style={[styles.metaChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Feather name="users" size={11} color={colors.mutedForeground} />
                    <Text style={[styles.metaChipText, { color: colors.mutedForeground }]}>{filled}/{item.headcount}</Text>
                  </View>
                  {typeof item.distanceMilesFromHome === "number" && (() => {
                    const d = item.distanceMilesFromHome as number;
                    const far = d >= FAR_MILES;
                    const color = far ? colors.accent : colors.success;
                    return (
                      <View style={[styles.metaChip, { backgroundColor: color + "15", borderColor: color + "55" }]}>
                        <Feather name="navigation" size={11} color={color} />
                        <Text style={[styles.metaChipText, { color, fontWeight: "700" }]}>
                          {d < 1 ? "<1 mi" : `${Math.round(d)} mi`}{far ? " · far" : ""}
                        </Text>
                      </View>
                    );
                  })()}
                </View>

                <View style={styles.detailRow}>
                  <Feather name="calendar" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.foreground, fontWeight: "600" }]} numberOfLines={1}>
                    {start.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – {new Date(item.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>

                <View style={styles.detailRow}>
                  <Feather name="map-pin" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.mutedForeground }]} numberOfLines={1}>{item.location}</Text>
                </View>

                {!isSiteManager && (
                  <View style={styles.rateRow}>
                    <Text style={[styles.rateText, { color: colors.primary }]}>${parseFloat(item.payRate ?? item.hourlyRate ?? "0").toFixed(2)}/hr</Text>
                    <Text style={[styles.earnText, { color: colors.mutedForeground }]}>
                      ≈ ${(parseFloat(item.payRate ?? item.hourlyRate ?? "0") * parseFloat(duration)).toFixed(2)} total
                    </Text>
                  </View>
                )}

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
                    accessibilityRole="button"
                    accessibilityLabel={`Request slot for ${item.title} at ${item.clientName}`}
                    accessibilityState={{ disabled: busy, busy }}
                  >
                    {busy ? <ActivityIndicator color={colors.primaryForeground} /> : (
                      <>
                        <Feather name="bookmark" size={16} color={colors.primaryForeground} />
                        <Text style={[styles.claimText, { color: colors.primaryForeground }]}>Request Slot</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}

                {isPending && (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TouchableOpacity
                      style={[styles.acceptBtn, { backgroundColor: colors.success, opacity: busy ? 0.6 : 1 }]}
                      onPress={() => handleAccept(item, myAssign!.id)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel={`Accept shift ${item.title} at ${item.clientName}`}
                      accessibilityState={{ disabled: busy, busy }}
                    >
                      {busy ? <ActivityIndicator color={colors.successForeground} /> : (
                        <>
                          <Feather name="check" size={16} color={colors.successForeground} />
                          <Text style={[styles.acceptText, { color: colors.successForeground }]}>Accept</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.declineBtn, { borderColor: colors.destructive, opacity: busy ? 0.6 : 1 }]}
                      onPress={() => handleDecline(item, myAssign!.id)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel={`Decline shift ${item.title} at ${item.clientName}`}
                      accessibilityState={{ disabled: busy, busy }}
                    >
                      <Feather name="x" size={16} color={colors.destructive} />
                      <Text style={[styles.declineText, { color: colors.destructive }]}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {isAccepted && item.shiftType === "ppo_detail" && (
                  <TouchableOpacity
                    style={[styles.opsPlanBtn, { borderColor: colors.accent, backgroundColor: colors.accent + "12" }]}
                    onPress={() => router.push({
                      pathname: "/(employee)/ops-plan/[id]",
                      params: { id: item.id, title: item.title, client: item.clientName },
                    })}
                    accessibilityRole="button"
                    accessibilityLabel={`View protection ops plan for ${item.title} at ${item.clientName}`}
                    accessibilityHint="Opens the protection package: principals, threats, itinerary and instructions"
                  >
                    <Feather name="shield" size={16} color={colors.accent} />
                    <Text style={[styles.opsPlanText, { color: colors.accent }]}>View Protection Ops Plan</Text>
                    <Feather name="chevron-right" size={16} color={colors.accent} style={{ marginLeft: "auto" }} />
                  </TouchableOpacity>
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
                        <View style={[styles.statusBanner, { backgroundColor: colors.success + "20", borderColor: colors.success, flex: 1 }]}>
                          <Feather name="clock" size={14} color={colors.success} />
                          <Text style={[styles.statusBannerText, { color: colors.success }]}>{COPY_ON_DUTY_BANNER}</Text>
                        </View>
                      )}
                      {canClockIn && !clockedInToThisShift && (
                        <TouchableOpacity
                          style={[styles.acceptBtn, { backgroundColor: colors.success, opacity: busy ? 0.6 : 1 }]}
                          onPress={() => handleClockInToShift(item)}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={`Clock in now to ${item.title} at ${item.clientName}`}
                          accessibilityState={{ disabled: busy, busy }}
                        >
                          {busy ? <ActivityIndicator color={colors.successForeground} /> : (
                            <>
                              <Feather name="play" size={16} color={colors.successForeground} />
                              <Text style={[styles.acceptText, { color: colors.successForeground }]}>Clock In Now</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      )}
                      {canRelease && (
                        <TouchableOpacity
                          style={[styles.declineBtn, { borderColor: colors.destructive, opacity: busy ? 0.6 : 1 }]}
                          onPress={() => handleDecline(item, myAssign.id)}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={`Release shift ${item.title} at ${item.clientName}`}
                          accessibilityState={{ disabled: busy, busy: busy && !canClockIn }}
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
                          accessibilityRole="button"
                          accessibilityLabel={`Request swap for ${item.title} at ${item.clientName}`}
                          accessibilityHint="Opens the shift swap request form"
                          accessibilityState={{ disabled: busy }}
                        >
                          <Feather name="repeat" size={14} color={colors.primary} />
                          <Text style={[styles.declineText, { color: colors.primary }]}>Request Swap</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })()}
              </Animated.View>
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
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sectionHeaderText: { fontSize: 15, fontWeight: "800", letterSpacing: 0.3 },
  sectionCount: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  sectionCountText: { fontSize: 11, fontWeight: "600" },
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
  metaRow: { flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" },
  metaChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1 },
  metaChipText: { fontSize: 11, fontWeight: "600" },
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
  opsPlanBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1.5 },
  opsPlanText: { fontSize: 14, fontWeight: "700" },
});
