import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Alert } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import {
  useGetAdminDashboardSummary, getGetAdminDashboardSummaryQueryKey,
  useGetShifts, getGetShiftsQueryKey,
  useNotifyShiftVacancy,
  useUpdateShiftAssignment,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmAction, notify } from "@/utils/confirm";
import { useQueryClient } from "@tanstack/react-query";

function StatCard({ label, value, color, icon, onPress }: { label: string; value: number | string; color?: string; icon: string; onPress?: () => void }) {
  const colors = useColors();
  const body = (
    <>
      <Feather name={icon as any} size={20} color={color || colors.primary} />
      <Text style={[styles.statValue, { color: color || colors.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </>
  );
  if (onPress) {
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={onPress}
        style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
      >
        {body}
      </TouchableOpacity>
    );
  }
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {body}
    </View>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors = useColors();
  const colorMap: Record<string, string> = {
    low: "#22c55e", medium: "#f59e0b", high: "#f97316", critical: colors.destructive
  };
  return (
    <View style={[styles.badge, { backgroundColor: colorMap[severity] + "30", borderColor: colorMap[severity] }]}>
      <Text style={[styles.badgeText, { color: colorMap[severity] }]}>{severity.toUpperCase()}</Text>
    </View>
  );
}

export default function AdminDashboardScreen() {
  const colors = useColors();
  const { logout, user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topPad = useTopPad();
  const { data: summary, isLoading, error, refetch } = useGetAdminDashboardSummary({
    query: { queryKey: getGetAdminDashboardSummaryQueryKey() }
  });
  const { data: upcomingShifts } = useGetShifts(
    { status: "upcoming" as any },
    { query: { queryKey: getGetShiftsQueryKey({ status: "upcoming" as any }) } },
  );
  const notifyMutation = useNotifyShiftVacancy();
  const [notifyingId, setNotifyingId] = React.useState<string | null>(null);
  const queryClient = useQueryClient();
  const updateAssignment = useUpdateShiftAssignment();
  const [decidingId, setDecidingId] = React.useState<string | null>(null);

  const pendingClaims = React.useMemo(() => {
    const rows: { assignmentId: string; shiftId: string; employeeName: string; shiftTitle: string; startTime: string; requiredLicenseLevel: number }[] = [];
    for (const s of (upcomingShifts ?? []) as any[]) {
      for (const a of (s.assignments ?? []) as any[]) {
        if (a.status !== "pending_approval") continue;
        rows.push({
          assignmentId: a.id,
          shiftId: s.id,
          employeeName: a.employeeName ?? "Officer",
          shiftTitle: s.title ?? "Shift",
          startTime: s.startTime,
          requiredLicenseLevel: s.requiredLicenseLevel ?? 0,
        });
      }
    }
    return rows.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }, [upcomingShifts]);

  const decideAssignment = async (shiftId: string, assignmentId: string, decision: "accepted" | "declined") => {
    setDecidingId(assignmentId);
    try {
      await updateAssignment.mutateAsync({ id: shiftId, assignmentId, data: { status: decision } } as any);
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey({ status: "upcoming" as any }) });
    } catch (e: any) {
      Alert.alert("Failed", e?.response?.data?.message || e?.message || "Could not update the request.");
    } finally {
      setDecidingId(null);
    }
  };

  const openVacancies = (upcomingShifts ?? [])
    .map((s: any) => {
      const filled = (s.assignments ?? []).length;
      const headcount = s.headcount ?? 1;
      return { ...s, filled, headcount, vacancies: Math.max(0, headcount - filled) };
    })
    .filter((s: any) => s.vacancies > 0)
    .sort((a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(0, 6);

  const handleNotify = async (shift: any) => {
    const ok = await confirmAction({
      title: "Notify Qualified Officers?",
      message: `Send a push to all active officers with Level ${shift.requiredLicenseLevel}+ clearance who aren't already on "${shift.title}".`,
      confirmText: "Send",
    });
    if (!ok) return;
    setNotifyingId(shift.id);
    try {
      const result: any = await notifyMutation.mutateAsync({ id: shift.id });
      notify("Reminder Sent", `Pushed to ${result?.notifiedCount ?? 0} qualified officer(s). ${result?.vacanciesRemaining ?? shift.vacancies} vacancy(ies) still open.`);
    } catch (e: any) {
      notify("Failed", e?.response?.data?.message || e?.message || "Could not send reminders");
    } finally {
      setNotifyingId(null);
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load dashboard</Text>
        <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Retry loading dashboard">
          <Text style={{ color: colors.primary }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Welcome back,</Text>
          <Text style={[styles.name, { color: colors.foreground }]}>{user?.firstName} {user?.lastName}</Text>
        </View>
        <TouchableOpacity
          onPress={logout}
          style={[styles.logoutBtn, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Feather name="log-out" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>OPERATIONAL STATUS</Text>
        <View style={styles.statsGrid}>
          <StatCard label="Active Shifts" value={summary?.activeShifts ?? 0} icon="activity" color={colors.primary} onPress={() => router.push("/(admin)/shifts" as any)} />
          <StatCard label="Clocked In" value={summary?.clockedInNow ?? 0} icon="clock" color="#22c55e" onPress={() => router.push("/(admin)/live-map" as any)} />
          <StatCard label="Open Incidents" value={summary?.openIncidents ?? 0} icon="alert-triangle" color={summary?.criticalIncidents ? colors.destructive : colors.accent} onPress={() => router.push("/(admin)/incidents" as any)} />
          <StatCard label="Upcoming" value={summary?.upcomingShifts ?? 0} icon="calendar" onPress={() => router.push("/(admin)/shifts" as any)} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>PERSONNEL</Text>
        <View style={styles.statsGrid}>
          <StatCard label="Total Staff" value={summary?.totalEmployees ?? 0} icon="users" onPress={() => router.push({ pathname: "/(admin)/employees", params: { status: "all" } } as any)} />
          <StatCard label="Active" value={summary?.activeEmployees ?? 0} icon="user-check" color="#22c55e" onPress={() => router.push({ pathname: "/(admin)/employees", params: { status: "active" } } as any)} />
          <StatCard label="Pending" value={summary?.pendingEmployees ?? 0} icon="user-plus" color={colors.accent} onPress={() => router.push({ pathname: "/(admin)/employees", params: { status: "pending" } } as any)} />
          <StatCard label="Expiring Licences" value={summary?.expiringLicenses ?? 0} icon="file-text" color={summary?.expiringLicenses ? colors.destructive : colors.mutedForeground} onPress={() => router.push("/(admin)/licenses" as any)} />
        </View>
      </View>

      {pendingClaims.length > 0 && (
        <View style={styles.section}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <Text style={[styles.sectionTitle, { color: colors.accent, marginBottom: 0, flex: 1 }]}>
              SHIFT CLAIM APPROVALS ({pendingClaims.length})
            </Text>
            <Feather name="user-check" size={14} color={colors.accent} />
          </View>
          {pendingClaims.map((claim) => {
            const start = new Date(claim.startTime);
            const isBusy = decidingId === claim.assignmentId;
            return (
              <View
                key={claim.assignmentId}
                style={[styles.claimCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={{ flex: 1, marginBottom: 10 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <Text style={[styles.itemTitle, { color: colors.foreground }]} numberOfLines={1}>{claim.employeeName}</Text>
                    <View style={[styles.levelBadge, { backgroundColor: colors.accent + "20", borderColor: colors.accent }]}>
                      <Text style={{ color: colors.accent, fontSize: 10, fontWeight: "700" }}>L{claim.requiredLicenseLevel}</Text>
                    </View>
                  </View>
                  <Text style={[styles.itemSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {claim.shiftTitle} · {start.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TouchableOpacity
                    style={[styles.decideBtn, { backgroundColor: "#22c55e", opacity: isBusy ? 0.6 : 1 }]}
                    disabled={isBusy}
                    onPress={() => decideAssignment(claim.shiftId, claim.assignmentId, "accepted")}
                    accessibilityRole="button"
                    accessibilityLabel={`Approve ${claim.employeeName} for ${claim.shiftTitle}`}
                    accessibilityState={{ disabled: isBusy, busy: isBusy }}
                  >
                    {isBusy && decidingId === claim.assignmentId ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Feather name="check" size={13} color="#fff" />
                        <Text style={styles.decideBtnText}>Approve</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.decideBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: "#ef4444", opacity: isBusy ? 0.6 : 1 }]}
                    disabled={isBusy}
                    onPress={() => decideAssignment(claim.shiftId, claim.assignmentId, "declined")}
                    accessibilityRole="button"
                    accessibilityLabel={`Decline ${claim.employeeName} for ${claim.shiftTitle}`}
                    accessibilityState={{ disabled: isBusy, busy: isBusy }}
                  >
                    <Feather name="x" size={13} color="#ef4444" />
                    <Text style={[styles.decideBtnText, { color: "#ef4444" }]}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {openVacancies.length > 0 && (
        <View style={styles.section}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <Text style={[styles.sectionTitle, { color: colors.accent, marginBottom: 0, flex: 1 }]}>
              OPEN VACANCIES ({openVacancies.reduce((n: number, s: any) => n + s.vacancies, 0)})
            </Text>
            <Feather name="alert-circle" size={14} color={colors.accent} />
          </View>
          {openVacancies.map((shift: any) => {
            const start = new Date(shift.startTime);
            const isNotifying = notifyingId === shift.id;
            return (
              <View
                key={shift.id}
                style={[styles.vacancyCard, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: colors.accent }]}
              >
                <TouchableOpacity
                  onPress={() => router.push(`/(admin)/shifts/${shift.id}` as any)}
                  style={{ flex: 1 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Open vacancy: ${shift.title}, ${shift.vacancies} of ${shift.headcount} open, Level ${shift.requiredLicenseLevel} or higher`}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <Text style={[styles.itemTitle, { color: colors.foreground }]} numberOfLines={1}>{shift.title}</Text>
                    <View style={[styles.vacancyPill, { backgroundColor: colors.accent + "25", borderColor: colors.accent }]}>
                      <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>
                        {shift.vacancies}/{shift.headcount} open
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.itemSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {shift.clientName} · {start.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · L{shift.requiredLicenseLevel}+
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleNotify(shift)}
                  disabled={isNotifying}
                  style={[styles.notifyBtn, { backgroundColor: colors.primary, opacity: isNotifying ? 0.6 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Notify qualified officers for ${shift.title}`}
                  accessibilityState={{ disabled: isNotifying, busy: isNotifying }}
                >
                  {isNotifying ? (
                    <ActivityIndicator color={colors.primaryForeground} size="small" />
                  ) : (
                    <>
                      <Feather name="bell" size={14} color={colors.primaryForeground} />
                      <Text style={[styles.notifyText, { color: colors.primaryForeground }]}>Notify</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>ADMIN ACTIONS</Text>
        <View style={styles.actionRow}>
          {[
            { label: "Clients", icon: "briefcase", route: "/(admin)/clients" },
            { label: "Time Approval", icon: "check-square", route: "/(admin)/time-approval" },
            { label: "Payroll", icon: "dollar-sign", route: "/(admin)/payroll" },
            { label: "Invoices", icon: "file-text", route: "/(admin)/invoices" },
            { label: "Licences", icon: "award", route: "/(admin)/licenses" },
            // Admins are shift workers too: "My Work" switches to the officer
            // shell (Home / My Shifts / Clock / …) where they can claim and
            // work shifts like any employee. replace() swaps tab navigators
            // cleanly; the profile screen there offers "Switch to Admin" back.
            { label: "My Work", icon: "user", route: "/(employee)/home", replace: true },
          ].map(({ label, icon, route, replace }) => (
            <TouchableOpacity
              key={label}
              style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => (replace ? router.replace(route as any) : router.push(route as any))}
              accessibilityRole="button"
              accessibilityLabel={label}
            >
              <Feather name={icon as any} size={22} color={colors.primary} />
              <Text style={[styles.actionLabel, { color: colors.foreground }]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={[styles.pendingBanner, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="alert-circle" size={18} color={colors.accent} />
          <Text style={[styles.pendingText, { color: colors.foreground }]}>
            {summary?.pendingPayroll ?? 0} payroll entries pending processing
          </Text>
        </View>
      </View>

      {(summary?.recentIncidents?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>RECENT INCIDENTS</Text>
          {summary!.recentIncidents.map((incident) => (
            <TouchableOpacity
              key={incident.id}
              style={[styles.listItem, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push("/(admin)/incidents")}
              accessibilityRole="button"
              accessibilityLabel={`${incident.severity} severity incident: ${incident.title}. Reported by ${incident.employeeName} on ${new Date(incident.occurredAt).toLocaleDateString()}`}
            >
              <View style={styles.itemRow}>
                <SeverityBadge severity={incident.severity} />
                <Text style={[styles.itemTitle, { color: colors.foreground }]} numberOfLines={1}>{incident.title}</Text>
              </View>
              <Text style={[styles.itemSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                {incident.employeeName} · {new Date(incident.occurredAt).toLocaleDateString()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {(summary?.upcomingShiftsList?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>UPCOMING SHIFTS</Text>
          {summary!.upcomingShiftsList.map((shift) => (
            <TouchableOpacity
              key={shift.id}
              style={[styles.listItem, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(`/(admin)/shifts/${shift.id}` as any)}
              accessibilityRole="button"
              accessibilityLabel={`Upcoming shift: ${shift.title} for ${shift.clientName} on ${new Date(shift.startTime).toLocaleString()}`}
            >
              <Text style={[styles.itemTitle, { color: colors.foreground }]}>{shift.title}</Text>
              <Text style={[styles.itemSub, { color: colors.mutedForeground }]}>
                {shift.clientName} · {new Date(shift.startTime).toLocaleString()}
              </Text>
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
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: 1,
  },
  greeting: { fontSize: 13, letterSpacing: 1 },
  name: { fontSize: 20, fontWeight: "700" },
  logoutBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statCard: {
    flex: 1, minWidth: "45%", padding: 14, borderRadius: 10, borderWidth: 1,
    alignItems: "center", gap: 6,
  },
  statValue: { fontSize: 28, fontWeight: "700" },
  statLabel: { fontSize: 11, textAlign: "center", letterSpacing: 0.5 },
  actionRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  actionBtn: {
    flex: 1, padding: 16, borderRadius: 10, borderWidth: 1,
    alignItems: "center", gap: 8,
  },
  actionLabel: { fontSize: 12, fontWeight: "600" },
  pendingBanner: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 14, borderRadius: 10, borderWidth: 1,
  },
  pendingText: { fontSize: 13, flex: 1 },
  listItem: { padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 8, gap: 4 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  itemTitle: { fontSize: 14, fontWeight: "600", flex: 1 },
  itemSub: { fontSize: 12 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  vacancyCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 12, borderRadius: 10, borderWidth: 1, borderLeftWidth: 3, marginBottom: 8,
  },
  vacancyPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  notifyBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
  },
  notifyText: { fontSize: 12, fontWeight: "700" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  claimCard: {
    padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 8,
  },
  levelBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  decideBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 5, paddingVertical: 8, borderRadius: 8,
  },
  decideBtnText: { fontSize: 12, fontWeight: "700", color: "#fff" },
});
