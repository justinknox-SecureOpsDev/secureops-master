import React, { useState, useMemo } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, TextInput, Alert, Platform, Modal, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetTimeEntries, getGetTimeEntriesQueryKey, useApproveTimeEntry, useUpdateTimeEntryTimes } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

// "unconfirmed" = clocked-out entries the officer hasn't confirmed yet
// (confirmationStatus === 'awaiting_confirmation'). They're kept out of the
// Pending tab so the approval queue only shows officer-submitted entries, but
// admins can still approve/correct them from the Unconfirmed tab (approval
// force-clears the awaiting state server-side).
const FILTERS = ["pending", "unconfirmed", "approved", "rejected"] as const;

const EDIT_PURPLE = "#8b5cf6";

function fmtDelta(origIso: string | null, submittedIso: string | null): string | null {
  if (!origIso || !submittedIso) return null;
  const diffMin = Math.round((new Date(submittedIso).getTime() - new Date(origIso).getTime()) / 60000);
  if (diffMin === 0) return "no change";
  return `${diffMin > 0 ? "+" : "−"}${Math.abs(diffMin)} min`;
}

type ReviewEntry = {
  employeeName: string | null;
  clockInTime: string;
  clockOutTime: string | null;
  originalClockInTime: string | null;
  originalClockOutTime: string | null;
  employeeEditReason: string | null;
};

// Local-time value for the YYYY-MM-DDTHH:MM correction inputs. Matches the
// convention the shift editor already uses for date/time text fields, so we
// don't pull in a date-picker dependency for two fields.
function fmtLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// `initial*` snapshots what the inputs were seeded with, so save can send ONLY
// the field the approver actually touched. The inputs are minute-granular, so
// round-tripping an untouched field would silently discard the seconds the
// officer's clock actually recorded.
type TimeEdit = {
  id: string;
  employeeName: string | null;
  clockIn: string;
  clockOut: string;
  initialClockIn: string;
  initialClockOut: string;
};

export default function TimeApprovalScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();
  const [filter, setFilter] = useState<typeof FILTERS[number]>("pending");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [review, setReview] = useState<ReviewEntry | null>(null);
  const [timeEdit, setTimeEdit] = useState<TimeEdit | null>(null);

  const { data: entries, isLoading, refetch } = useGetTimeEntries({}, {
    query: { queryKey: getGetTimeEntriesQueryKey({}) },
  });

  const approve = useApproveTimeEntry();
  const updateTimes = useUpdateTimeEntryTimes();

  const visible = useMemo(() => {
    return ((entries ?? []) as any[])
      .filter((e) => e.clockOutTime)
      .filter((e) => {
        const awaiting = e.confirmationStatus === "awaiting_confirmation";
        if (filter === "unconfirmed") return awaiting && (e.approvalStatus || "pending") === "pending";
        if (filter === "pending") return !awaiting && (e.approvalStatus || "pending") === "pending";
        return (e.approvalStatus || "pending") === filter;
      })
      .sort((a, b) => new Date(b.clockInTime).getTime() - new Date(a.clockInTime).getTime());
  }, [entries, filter]);

  const handle = (id: string, decision: "approved" | "rejected", logged: string) => {
    const override = edits[id];
    const hours = override ? parseFloat(override) : parseFloat(logged);
    if (decision === "approved" && (!Number.isFinite(hours) || hours <= 0)) {
      Alert.alert("Invalid hours", "Enter a positive number of hours."); return;
    }
    approve.mutateAsync({
      id,
      data: { decision, hoursWorked: decision === "approved" ? hours : undefined },
    } as any).then(() => {
      queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey({}) });
      setEdits((e) => { const n = { ...e }; delete n[id]; return n; });
    }).catch((e: any) => Alert.alert("Failed", e?.response?.data?.message || e?.message || "Approval failed"));
  };

  // Correct an officer's recorded clock-in / clock-out. Admins may fix any
  // entry; site managers are restricted server-side to sites they manage and
  // get a 403 with an explanatory message otherwise, so surface the server's
  // message rather than a generic failure. Hours are recomputed server-side.
  const saveTimes = () => {
    if (!timeEdit) return;
    const inDate = new Date(timeEdit.clockIn);
    if (!timeEdit.clockIn || isNaN(inDate.getTime())) {
      Alert.alert("Check the clock-in", "Use the format YYYY-MM-DDTHH:MM, e.g. 2026-06-01T20:00."); return;
    }
    let outIso: string | undefined;
    if (timeEdit.clockOut) {
      const outDate = new Date(timeEdit.clockOut);
      if (isNaN(outDate.getTime())) {
        Alert.alert("Check the clock-out", "Use the format YYYY-MM-DDTHH:MM, e.g. 2026-06-02T04:00."); return;
      }
      if (outDate.getTime() <= inDate.getTime()) {
        Alert.alert("Check the times", "Clock-out must be after clock-in."); return;
      }
      outIso = outDate.toISOString();
    }
    // Send only what changed, so an untouched field keeps its recorded seconds.
    const data: { clockInTime?: string; clockOutTime?: string } = {};
    if (timeEdit.clockIn !== timeEdit.initialClockIn) data.clockInTime = inDate.toISOString();
    if (timeEdit.clockOut !== timeEdit.initialClockOut && outIso) data.clockOutTime = outIso;
    if (!data.clockInTime && !data.clockOutTime) { setTimeEdit(null); return; }

    const editedId = timeEdit.id;
    updateTimes.mutateAsync({ id: editedId, data } as any).then(() => {
      queryClient.invalidateQueries({ queryKey: getGetTimeEntriesQueryKey({}) });
      // Server recomputes hoursWorked — drop any stale local hours override so
      // the approve field reflects the corrected total.
      setEdits((e) => { const n = { ...e }; delete n[editedId]; return n; });
      setTimeEdit(null);
    }).catch((e: any) => Alert.alert("Couldn't save times", e?.response?.data?.message || e?.message || "Update failed"));
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Time Approval</Text>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)}
            style={[styles.chip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}
            accessibilityRole="button" accessibilityState={{ selected: filter === f }} accessibilityLabel={`Filter ${f.charAt(0).toUpperCase() + f.slice(1)}`}>
            <Text style={[styles.chipText, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="check-circle" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No {filter} time entries.</Text>
            </View>
          }
          refreshing={false}
          onRefresh={refetch}
          renderItem={({ item }: { item: any }) => {
            const logged = parseFloat(item.hoursWorked ?? "0").toFixed(2);
            const editVal = edits[item.id] ?? logged;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: colors.foreground }]}>{item.employeeName}</Text>
                    <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={2}>
                      <Feather name="briefcase" size={11} color={colors.mutedForeground} />{" "}
                      {item.shiftTitle ?? "Walk-in (no shift)"}
                    </Text>
                    <Text style={[styles.sub, { color: colors.mutedForeground, marginTop: 2 }]} numberOfLines={1}>
                      <Feather name="map-pin" size={11} color={colors.mutedForeground} />{" "}
                      {item.siteName ?? "Site unknown"}
                    </Text>
                  </View>
                  {/* Pay rate is stripped from the response for roles without
                      finance visibility (e.g. site managers) — render nothing
                      rather than a misleading $0.00/h. */}
                  {item.payRate != null && (
                    <View style={[styles.lvBadge, { backgroundColor: colors.primary + "20", borderColor: colors.primary }]}>
                      <Text style={{ color: colors.primary, fontSize: 11, fontWeight: "700" }}>${parseFloat(item.payRate).toFixed(2)}/h</Text>
                    </View>
                  )}
                </View>

                <View style={styles.timesRow}>
                  <Text style={[styles.line, { color: colors.mutedForeground, flex: 1 }]}>
                    {new Date(item.clockInTime).toLocaleString()} → {item.clockOutTime ? new Date(item.clockOutTime).toLocaleString() : "—"}
                  </Text>
                  {filter !== "rejected" && (
                    <TouchableOpacity
                      onPress={() => {
                        const clockIn = fmtLocalInput(item.clockInTime);
                        const clockOut = fmtLocalInput(item.clockOutTime ?? null);
                        setTimeEdit({
                          id: item.id,
                          employeeName: item.employeeName ?? null,
                          clockIn,
                          clockOut,
                          initialClockIn: clockIn,
                          initialClockOut: clockOut,
                        });
                      }}
                      style={[styles.editTimesBtn, { borderColor: colors.primary }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit clock in and out times for ${item.employeeName ?? "this entry"}`}
                      accessibilityHint="Opens a form to correct the recorded clock-in and clock-out"
                    >
                      <Feather name="clock" size={11} color={colors.primary} />
                      <Text style={{ color: colors.primary, fontSize: 11, fontWeight: "700" }}>Edit times</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {item.confirmationStatus === "awaiting_confirmation" && (
                  <View style={[styles.correctionBox, { backgroundColor: colors.primary + "12", borderColor: colors.primary }]}>
                    <View style={styles.correctionHead}>
                      <Feather name="clock" size={12} color={colors.primary} />
                      <Text style={[styles.correctionTitle, { color: colors.primary }]}>Awaiting officer confirmation</Text>
                    </View>
                    <Text style={[styles.correctionNote, { color: colors.mutedForeground }]}>
                      The officer hasn't reviewed this entry yet. You can still approve or correct it.
                    </Text>
                  </View>
                )}

                {item.employeeEdited && (
                  <TouchableOpacity
                    onPress={() => setReview({
                      employeeName: item.employeeName ?? null,
                      clockInTime: item.clockInTime,
                      clockOutTime: item.clockOutTime ?? null,
                      originalClockInTime: item.originalClockInTime ?? null,
                      originalClockOutTime: item.originalClockOutTime ?? null,
                      employeeEditReason: item.employeeEditReason ?? null,
                    })}
                    style={[styles.correctionBox, { backgroundColor: EDIT_PURPLE + "15", borderColor: EDIT_PURPLE }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Review officer time edit for ${item.employeeName ?? "this entry"}`}
                    accessibilityHint="Shows recorded versus submitted times and the officer's reason"
                  >
                    <View style={[styles.correctionHead, { justifyContent: "space-between" }]}>
                      <View style={styles.correctionHead}>
                        <Feather name="edit-2" size={12} color={EDIT_PURPLE} />
                        <Text style={[styles.correctionTitle, { color: EDIT_PURPLE }]}>Edited by officer</Text>
                      </View>
                      <View style={styles.correctionHead}>
                        <Text style={{ color: EDIT_PURPLE, fontSize: 11, fontWeight: "600" }}>Review</Text>
                        <Feather name="chevron-right" size={13} color={EDIT_PURPLE} />
                      </View>
                    </View>
                    {item.employeeEditReason ? (
                      <Text style={[styles.correctionNote, { color: colors.foreground }]} numberOfLines={2}>{item.employeeEditReason}</Text>
                    ) : null}
                  </TouchableOpacity>
                )}

                {item.correctionRequested && (
                  <View style={[styles.correctionBox, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive }]}>
                    <View style={styles.correctionHead}>
                      <Feather name="alert-triangle" size={12} color={colors.destructive} />
                      <Text style={[styles.correctionTitle, { color: colors.destructive }]}>Time correction requested</Text>
                    </View>
                    {item.correctionNote ? (
                      <Text style={[styles.correctionNote, { color: colors.foreground }]}>{item.correctionNote}</Text>
                    ) : null}
                  </View>
                )}

                {filter === "pending" || filter === "unconfirmed" ? (
                  <View style={[styles.editRow, { borderColor: colors.border }]}>
                    <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>Approve hours:</Text>
                    <TextInput
                      value={editVal}
                      onChangeText={(v) => setEdits((e) => ({ ...e, [item.id]: v }))}
                      keyboardType="decimal-pad"
                      style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                      accessibilityLabel={`Approve hours for ${item.employeeName}`}
                    />
                    <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>Logged {logged}h</Text>
                  </View>
                ) : (
                  <Text style={[styles.line, { color: filter === "approved" ? "#22c55e" : colors.destructive, fontWeight: "700" }]}>
                    {filter === "approved" ? `Approved · ${parseFloat(item.hoursWorked ?? "0").toFixed(2)}h` : "Rejected"}
                  </Text>
                )}

                {(filter === "pending" || filter === "unconfirmed") && (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TouchableOpacity onPress={() => handle(item.id, "approved", logged)}
                      style={[styles.actBtn, { backgroundColor: "#22c55e" }]}
                      disabled={approve.isPending}
                      accessibilityRole="button" accessibilityLabel={`Approve time entry for ${item.employeeName}`} accessibilityState={{ disabled: approve.isPending, busy: approve.isPending }}>
                      <Feather name="check" size={14} color="#fff" />
                      <Text style={[styles.actText, { color: "#fff" }]}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handle(item.id, "rejected", logged)}
                      style={[styles.actBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.destructive }]}
                      disabled={approve.isPending}
                      accessibilityRole="button" accessibilityLabel={`Reject time entry for ${item.employeeName}`} accessibilityState={{ disabled: approve.isPending, busy: approve.isPending }}>
                      <Feather name="x" size={14} color={colors.destructive} />
                      <Text style={[styles.actText, { color: colors.destructive }]}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      <Modal visible={!!review} transparent animationType="fade" onRequestClose={() => setReview(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.correctionHead, { justifyContent: "space-between" }]}>
              <View style={styles.correctionHead}>
                <Feather name="edit-2" size={14} color={EDIT_PURPLE} />
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Officer time edit</Text>
              </View>
              <TouchableOpacity onPress={() => setReview(null)} accessibilityRole="button" accessibilityLabel="Close review" style={{ padding: 4 }}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {review && (
              <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 12, paddingTop: 10 }}>
                {review.employeeName ? (
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                    {review.employeeName} changed their times before submitting. Review the difference before approving.
                  </Text>
                ) : (
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                    The officer changed their times before submitting. Review the difference before approving.
                  </Text>
                )}

                {([
                  { label: "Clock-in", orig: review.originalClockInTime, submitted: review.clockInTime },
                  { label: "Clock-out", orig: review.originalClockOutTime, submitted: review.clockOutTime },
                ] as const).map(({ label, orig, submitted }) => {
                  const delta = fmtDelta(orig, submitted);
                  return (
                    <View key={label} style={[styles.diffBlock, { borderColor: colors.border }]}>
                      <View style={[styles.correctionHead, { justifyContent: "space-between" }]}>
                        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700" }}>{label}</Text>
                        {delta ? (
                          <View style={[styles.deltaBadge, { backgroundColor: EDIT_PURPLE + "20", borderColor: EDIT_PURPLE }]}>
                            <Text style={{ color: EDIT_PURPLE, fontSize: 11, fontWeight: "700" }}>{delta}</Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.diffRow}>
                        <Text style={[styles.diffLabel, { color: colors.mutedForeground }]}>Recorded</Text>
                        <Text style={{ color: colors.mutedForeground, fontSize: 13, flex: 1 }}>
                          {orig ? new Date(orig).toLocaleString() : "—"}
                        </Text>
                      </View>
                      <View style={styles.diffRow}>
                        <Text style={[styles.diffLabel, { color: colors.mutedForeground }]}>Submitted</Text>
                        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
                          {submitted ? new Date(submitted).toLocaleString() : "—"}
                        </Text>
                      </View>
                    </View>
                  );
                })}

                <View style={[styles.diffBlock, { borderColor: colors.border }]}>
                  <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "700" }}>Officer's reason</Text>
                  <Text style={{ color: review.employeeEditReason ? colors.foreground : colors.mutedForeground, fontSize: 13, lineHeight: 18 }}>
                    {review.employeeEditReason || "No reason provided."}
                  </Text>
                </View>
              </ScrollView>
            )}
            <TouchableOpacity
              onPress={() => setReview(null)}
              style={[styles.actBtn, { backgroundColor: colors.primary, marginTop: 12 }]}
              accessibilityRole="button" accessibilityLabel="Done reviewing officer time edit">
              <Text style={[styles.actText, { color: colors.primaryForeground ?? "#fff" }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!timeEdit} transparent animationType="fade" onRequestClose={() => setTimeEdit(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.correctionHead, { justifyContent: "space-between" }]}>
              <View style={styles.correctionHead}>
                <Feather name="clock" size={14} color={colors.primary} />
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Correct clock times</Text>
              </View>
              <TouchableOpacity onPress={() => setTimeEdit(null)} accessibilityRole="button" accessibilityLabel="Close time correction" style={{ padding: 4 }}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {timeEdit && (
              <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 14, paddingTop: 10 }} keyboardShouldPersistTaps="handled">
                <Text style={{ color: colors.mutedForeground, fontSize: 12, lineHeight: 17 }}>
                  {timeEdit.employeeName
                    ? `Adjusting ${timeEdit.employeeName}'s recorded times.`
                    : "Adjusting the recorded times."}{" "}
                  Hours are recalculated automatically when you save.
                </Text>

                {([
                  { key: "clockIn" as const, label: "Clock-in", placeholder: "2026-06-01T20:00" },
                  { key: "clockOut" as const, label: "Clock-out", placeholder: "2026-06-02T04:00" },
                ]).map(({ key, label, placeholder }) => (
                  <View key={key} style={{ gap: 6 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label} (YYYY-MM-DDTHH:MM)</Text>
                    <TextInput
                      value={timeEdit[key]}
                      onChangeText={(v) => setTimeEdit((t) => (t ? { ...t, [key]: v } : t))}
                      placeholder={placeholder}
                      placeholderTextColor={colors.mutedForeground}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[styles.timeInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                      accessibilityLabel={`${label} time`}
                    />
                  </View>
                ))}
              </ScrollView>
            )}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
              <TouchableOpacity
                onPress={() => setTimeEdit(null)}
                style={[styles.actBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border }]}
                accessibilityRole="button" accessibilityLabel="Cancel time correction">
                <Text style={[styles.actText, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveTimes}
                disabled={updateTimes.isPending}
                style={[styles.actBtn, { backgroundColor: colors.primary, opacity: updateTimes.isPending ? 0.6 : 1 }]}
                accessibilityRole="button" accessibilityLabel="Save corrected times"
                accessibilityState={{ disabled: updateTimes.isPending, busy: updateTimes.isPending }}>
                <Text style={[styles.actText, { color: colors.primaryForeground ?? "#fff" }]}>
                  {updateTimes.isPending ? "Saving…" : "Save"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 14, fontWeight: "700" },
  sub: { fontSize: 12, marginTop: 2 },
  line: { fontSize: 12 },
  correctionBox: { marginTop: 8, padding: 10, borderRadius: 8, borderWidth: 1, gap: 4 },
  correctionHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  correctionTitle: { fontSize: 12, fontWeight: "700" },
  correctionNote: { fontSize: 13, lineHeight: 18 },
  lvBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  timesRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  editTimesBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  fieldLabel: { fontSize: 11, fontWeight: "600" },
  timeInput: { height: 42, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  editRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderRadius: 6, borderWidth: 1 },
  input: { width: 80, height: 36, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, fontSize: 14, textAlign: "center" },
  actBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderRadius: 8 },
  actText: { fontWeight: "700", fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 20 },
  modalCard: { borderRadius: 14, borderWidth: 1, padding: 16 },
  modalTitle: { fontSize: 16, fontWeight: "700" },
  diffBlock: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 6 },
  diffRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  diffLabel: { fontSize: 11, fontWeight: "600", width: 68, marginTop: 1 },
  deltaBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
});
