import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useGetAdminDashboardSummary, getGetAdminDashboardSummaryQueryKey,
  useGetShifts, getGetShiftsQueryKey,
  useNotifyShiftVacancy,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirmAction, notify } from "@/utils/confirm";

function StatCard({ label, value, color, icon }: { label: string; value: number | string; color?: string; icon: string }) {
  const colors = useColors();
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Feather name={icon as any} size={20} color={color || colors.primary} />
      <Text style={[styles.statValue, { color: color || colors.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
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
  const topPad = Platform.OS === "web" ? 67 : 0;
  const { data: summary, isLoading, error, refetch } = useGetAdminDashboardSummary({
    query: { queryKey: getGetAdminDashboardSummaryQueryKey() }
  });
  const { data: upcomingShifts } = useGetShifts(
    { status: "upcoming" as any },
    { query: { queryKey: getGetShiftsQueryKey({ status: "upcoming" as any }) } },
  );
  const notifyMutation = useNotifyShiftVacancy();
  const [notifyingId, setNotifyingId] = React.useState<string | null>(null);

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
        <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]}>
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
        <TouchableOpacity onPress={logout} style={[styles.logoutBtn, { borderColor: colors.border }]}>
          <Feather name="log-out" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>OPERATIONAL STATUS</Text>
        <View style={styles.statsGrid}>
          <StatCard label="Active Shifts" value={summary?.activeShifts ?? 0} icon="activity" color={colors.primary} />
          <StatCard label="Clocked In" value={summary?.clockedInNow ?? 0} icon="clock" color="#22c55e" />
          <StatCard label="Open Incidents" value={summary?.openIncidents ?? 0} icon="alert-triangle" color={summary?.criticalIncidents ? colors.destructive : colors.accent} />
          <StatCard label="Upcoming" value={summary?.upcomingShifts ?? 0} icon="calendar" />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>PERSONNEL</Text>
        <View style={styles.statsGrid}>
          <StatCard label="Total Staff" value={summary?.totalEmployees ?? 0} icon="users" />
          <StatCard label="Active" value={summary?.activeEmployees ?? 0} icon="user-check" color="#22c55e" />
          <StatCard label="Pending" value={summary?.pendingEmployees ?? 0} icon="user-plus" color={colors.accent} />
          <StatCard label="Expiring Licences" value={summary?.expiringLicenses ?? 0} icon="file-text" color={summary?.expiringLicenses ? colors.destructive : colors.mutedForeground} />
        </View>
      </View>

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
                <TouchableOpacity onPress={() => router.push(`/(admin)/shifts/${shift.id}` as any)} style={{ flex: 1 }}>
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
          ].map(({ label, icon, route }) => (
            <TouchableOpacity
              key={label}
              style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(route as any)}
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
              onPress={() => router.push("/(admin)/shifts")}
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
});
