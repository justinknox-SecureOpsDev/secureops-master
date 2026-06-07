import React, { useLayoutEffect, useMemo, useState } from "react";
import { useNavigation } from "expo-router";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, TextInput } from "react-native";
import { useColors } from "@/hooks/useColors";
import { confirmAction, notify } from "@/utils/confirm";
import { useGetShift, getGetShiftQueryKey, useGetEmployees, getGetEmployeesQueryKey, useAssignEmployeeToShift, useUpdateShiftAssignment, getGetShiftsQueryKey } from "@workspace/api-client-react";
import { LicenseLevelBadge, levelLabel } from "@/components/LicenseLevelBadge";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

function InfoRow({ label, value, icon }: { label: string; value?: string | null; icon: string }) {
  const colors = useColors();
  if (!value) return null;
  return (
    <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
      <Feather name={icon as any} size={14} color={colors.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: colors.foreground }]}>{value}</Text>
      </View>
    </View>
  );
}

export default function ShiftDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topPad = useTopPad();
  const navigation = useNavigation();
  useLayoutEffect(() => { (navigation as any).setOptions?.({ headerShown: false }); }, [navigation]);

  const { data: shift, isLoading } = useGetShift(id!, {
    query: { queryKey: getGetShiftQueryKey(id!), enabled: !!id }
  });
  const { data: allEmployees } = useGetEmployees(
    { status: "active" as any },
    { query: { queryKey: getGetEmployeesQueryKey({ status: "active" as any }) } },
  );

  const assignMutation = useAssignEmployeeToShift();
  const removeMutation = useUpdateShiftAssignment();

  const assignedIds = new Set((shift?.assignments ?? []).map((a) => a.employeeId));

  const handleAssign = async (employeeId: string, name: string, overrideLicense = false) => {
    const ok = overrideLicense
      ? await confirmAction({
          title: "Override License Requirement",
          message: `${name} isn't cleared for this shift's required license level. Assign anyway? This override is recorded in the audit log.`,
          confirmText: "Assign Anyway",
          destructive: true,
        })
      : await confirmAction({ title: "Assign Officer", message: `Assign ${name} to this shift?`, confirmText: "Assign" });
    if (!ok) return;
    try {
      await assignMutation.mutateAsync({ id: id!, data: { employeeId, ...(overrideLicense ? { overrideLicense: true } : {}) } });
      queryClient.invalidateQueries({ queryKey: getGetShiftQueryKey(id!) });
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Failed to assign";
      notify("Cannot Assign", msg);
    }
  };

  const handleRemove = async (assignmentId: string, name: string) => {
    const ok = await confirmAction({ title: "Remove Assignment", message: `Remove ${name} from this shift?`, confirmText: "Remove", destructive: true });
    if (!ok) return;
    try {
      await removeMutation.mutateAsync({ id: id!, assignmentId, data: { status: "declined" } as any });
      queryClient.invalidateQueries({ queryKey: getGetShiftQueryKey(id!) });
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
    } catch (e: any) {
      notify("Failed", e?.response?.data?.message || e?.message || "Could not remove");
    }
  };

  const statusColor = (s: string) => {
    const m: Record<string, string> = { upcoming: colors.primary, active: "#22c55e", completed: colors.mutedForeground, cancelled: colors.destructive };
    return m[s] || colors.mutedForeground;
  };

  // NOTE: all hooks must run before any early return below, otherwise React
  // throws "Rendered more hooks than during the previous render" when the
  // shift transitions from loading→loaded.
  const reqLevel = (shift as any)?.requiredLicenseLevel ?? 2;
  const headcount = (shift as any)?.headcount ?? 1;
  const unassignedAll = (allEmployees ?? []).filter((e) => !assignedIds.has(e.id));
  // Effective clearance mirrors the server's eligibility helper: a licensed
  // officer's level is their highest unexpired licence; support staff carry a
  // baseline of 1 ("Support / no licence required"); higher levels cover lower.
  // Filtering on raw maxLicenseLevel alone wrongly hid support / non-licensed
  // staff from level-1 (Support) shifts.
  const effLevel = (e: any) => Math.max(e.maxLicenseLevel ?? 0, e.position === "support_staff" ? 1 : 0);
  const eligibleAll = unassignedAll.filter((e: any) => effLevel(e) >= reqLevel);
  const ineligibleAll = unassignedAll.filter((e: any) => effLevel(e) < reqLevel);

  // Search across the qualified + not-qualified lists. Matches first/last
  // name and email so admins can find people fast on busy rosters.
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const matches = (e: any) => {
    if (!q) return true;
    const haystack = `${e.firstName ?? ""} ${e.lastName ?? ""} ${e.email ?? ""}`.toLowerCase();
    return haystack.includes(q);
  };
  const eligible = useMemo(() => eligibleAll.filter(matches), [eligibleAll, q]);
  const ineligible = useMemo(() => ineligibleAll.filter(matches), [ineligibleAll, q]);
  const isSearching = q.length > 0;

  if (isLoading) return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;
  if (!shift) return <View style={[styles.center, { backgroundColor: colors.background }]}><Text style={{ color: colors.destructive }}>Shift not found</Text></View>;

  const duration = ((new Date(shift.endTime).getTime() - new Date(shift.startTime).getTime()) / 3600000).toFixed(1);
  const filled = (shift.assignments ?? []).length;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} numberOfLines={1} accessibilityRole="header">{shift.title}</Text>
        <TouchableOpacity
          onPress={() => router.push(`/(admin)/shifts/edit/${id}` as any)}
          style={[styles.backBtn, { borderColor: colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Edit shift"
        >
          <Feather name="edit-2" size={16} color={colors.primary} />
        </TouchableOpacity>
        <View style={[styles.statusBadge, { backgroundColor: statusColor(shift.status) + "20", borderColor: statusColor(shift.status) }]}>
          <Text style={[styles.statusText, { color: statusColor(shift.status) }]}>{shift.status.toUpperCase()}</Text>
        </View>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.heroRow}>
          <Feather name="briefcase" size={18} color={colors.primary} />
          <Text style={[styles.clientName, { color: colors.primary }]}>{shift.clientName}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <LicenseLevelBadge level={reqLevel} size="md" />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Feather name="users" size={13} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
              {filled}/{headcount} officers
            </Text>
          </View>
        </View>
        <View style={styles.heroRow}>
          <Feather name="map-pin" size={16} color={colors.mutedForeground} />
          <Text style={[styles.heroSub, { color: colors.mutedForeground }]}>{shift.location}</Text>
        </View>
        <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
          <View style={styles.statItem}>
            <Text style={[styles.statVal, { color: colors.foreground }]}>{duration}h</Text>
            <Text style={[styles.statLbl, { color: colors.mutedForeground }]}>Duration</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.statItem}>
            <Text style={[styles.statVal, { color: colors.primary }]}>${parseFloat(((shift as any).payRate ?? (shift as any).hourlyRate ?? "0") as any).toFixed(2)}</Text>
            <Text style={[styles.statLbl, { color: colors.mutedForeground }]}>Pay Rate</Text>
          </View>
          {(shift as any).billRate && <>
            <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
            <View style={styles.statItem}>
              <Text style={[styles.statVal, { color: colors.accent }]}>${parseFloat((shift as any).billRate as any).toFixed(2)}</Text>
              <Text style={[styles.statLbl, { color: colors.mutedForeground }]}>Bill Rate</Text>
            </View>
          </>}
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>SCHEDULE</Text>
        <InfoRow label="Start Time" value={new Date(shift.startTime).toLocaleString()} icon="play-circle" />
        <InfoRow label="End Time" value={new Date(shift.endTime).toLocaleString()} icon="stop-circle" />
        <InfoRow label="Notes" value={shift.notes} icon="file-text" />
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>ASSIGNED PERSONNEL ({shift.assignments?.length ?? 0})</Text>
        {(shift.assignments ?? []).length === 0 && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No personnel assigned yet</Text>
        )}
        {(shift.assignments ?? []).map((a) => (
          <View key={a.id} style={[styles.personRow, { borderBottomColor: colors.border }]}>
            <View style={[styles.avatar, { backgroundColor: colors.primary + "20" }]}>
              <Text style={[styles.avatarText, { color: colors.primary }]}>{(a.employeeName || "?")[0]}</Text>
            </View>
            <TouchableOpacity
              style={{ flex: 1 }}
              onPress={() => router.push(`/(admin)/employees/${a.employeeId}` as any)}
              accessibilityRole="button"
              accessibilityLabel={`View profile for ${a.employeeName}`}
            >
              <Text style={[styles.personName, { color: colors.foreground }]}>{a.employeeName}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleRemove(a.id, a.employeeName || "")} style={[styles.removeBtn, { borderColor: colors.destructive + "40" }]} accessibilityRole="button" accessibilityLabel={`Remove ${a.employeeName} from shift`}>
              <Feather name="x" size={16} color={colors.destructive} />
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {(eligibleAll.length > 0 || ineligibleAll.length > 0) && (
        <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search officers by name or email"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.searchInput, { color: colors.foreground }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search officers by name or email"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")} accessibilityRole="button" accessibilityLabel="Clear search">
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {eligibleAll.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>
            ADD QUALIFIED PERSONNEL ({eligible.length}{isSearching ? ` of ${eligibleAll.length}` : ""})
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 11, marginBottom: 8 }}>
            Showing officers with {levelLabel(reqLevel)} or higher.
          </Text>
          {eligible.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No qualified officers match “{search}”.</Text>
          )}
          {(isSearching ? eligible : eligible.slice(0, 15)).map((emp: any) => (
            <TouchableOpacity
              key={emp.id}
              style={[styles.personRow, { borderBottomColor: colors.border }]}
              onPress={() => handleAssign(emp.id, `${emp.firstName} ${emp.lastName}`)}
              accessibilityRole="button"
              accessibilityLabel={`Assign ${emp.firstName} ${emp.lastName} to shift`}
            >
              <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
                <Text style={[styles.avatarText, { color: colors.mutedForeground }]}>{emp.firstName[0]}{emp.lastName[0]}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.personName, { color: colors.foreground }]}>{emp.firstName} {emp.lastName}</Text>
                <View style={{ marginTop: 3 }}>
                  <LicenseLevelBadge level={emp.maxLicenseLevel} size="sm" />
                </View>
              </View>
              <Feather name="plus-circle" size={20} color={colors.primary} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {ineligibleAll.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, opacity: 0.7 }]}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            NOT QUALIFIED ({ineligible.length}{isSearching ? ` of ${ineligibleAll.length}` : ""})
          </Text>
          {isSearching && ineligible.length === 0 && (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No matches.</Text>
          )}
          <Text style={{ color: colors.mutedForeground, fontSize: 11, marginBottom: 8 }}>
            Below the required {levelLabel(reqLevel)}. Tap to assign with a license override (audit-logged).
          </Text>
          {(isSearching ? ineligible : ineligible.slice(0, 8)).map((emp: any) => (
            <TouchableOpacity
              key={emp.id}
              style={[styles.personRow, { borderBottomColor: colors.border }]}
              onPress={() => handleAssign(emp.id, `${emp.firstName} ${emp.lastName}`, true)}
              accessibilityRole="button"
              accessibilityLabel={`Assign ${emp.firstName} ${emp.lastName} with license override`}
            >
              <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
                <Text style={[styles.avatarText, { color: colors.mutedForeground }]}>{emp.firstName[0]}{emp.lastName[0]}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.personName, { color: colors.mutedForeground }]}>{emp.firstName} {emp.lastName}</Text>
                <View style={{ marginTop: 3 }}>
                  <LicenseLevelBadge level={emp.maxLicenseLevel} size="sm" />
                </View>
              </View>
              <Feather name="alert-triangle" size={16} color={colors.accent} />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { flex: 1, fontSize: 16, fontWeight: "700" },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: "700" },
  heroCard: { margin: 16, padding: 18, borderRadius: 14, borderWidth: 1, gap: 10 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  clientName: { fontSize: 17, fontWeight: "700", flex: 1 },
  heroSub: { fontSize: 13, flex: 1 },
  statsRow: { flexDirection: "row", paddingTop: 14, borderTopWidth: 1, marginTop: 4 },
  statItem: { flex: 1, alignItems: "center" },
  statVal: { fontSize: 20, fontWeight: "700" },
  statLbl: { fontSize: 11, marginTop: 2 },
  statDivider: { width: 1, marginVertical: 4 },
  section: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, borderWidth: 1, padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  infoLabel: { fontSize: 11, marginBottom: 2 },
  infoValue: { fontSize: 14 },
  personRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1 },
  avatar: { width: 36, height: 36, borderRadius: 18, justifyContent: "center", alignItems: "center" },
  avatarText: { fontWeight: "700", fontSize: 14 },
  personName: { flex: 1, fontSize: 14, fontWeight: "500" },
  removeBtn: { padding: 6, borderRadius: 6, borderWidth: 1 },
  emptyText: { fontSize: 13, fontStyle: "italic" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 12 : 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 6 },
});
