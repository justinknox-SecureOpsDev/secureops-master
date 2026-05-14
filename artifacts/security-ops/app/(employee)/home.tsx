import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Image } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetEmployeeDashboardSummary, getGetEmployeeDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

function SeverityBadge({ severity }: { severity: string }) {
  const colors = useColors();
  const map: Record<string, string> = { low: "#22c55e", medium: colors.accent, high: "#f97316", critical: colors.destructive };
  const c = map[severity] || colors.mutedForeground;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{severity.toUpperCase()}</Text>
    </View>
  );
}

export default function EmployeeHomeScreen() {
  const colors = useColors();
  const { logout, user } = useAuth();
  const router = useRouter();
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: summary, isLoading, error, refetch } = useGetEmployeeDashboardSummary({
    query: { queryKey: getGetEmployeeDashboardSummaryQueryKey() }
  });

  if (isLoading) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Image source={require("@/assets/images/logo.jpeg")} style={styles.logoSmall} resizeMode="contain" />
        <View style={{ flex: 1 }}>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Good day,</Text>
          <Text style={[styles.name, { color: colors.foreground }]}>{user?.firstName} {user?.lastName}</Text>
        </View>
        <TouchableOpacity onPress={logout} style={[styles.logoutBtn, { borderColor: colors.border }]}>
          <Feather name="log-out" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      {summary?.clockedIn && (
        <View style={[styles.clockedInBanner, { backgroundColor: "#22c55e20", borderColor: "#22c55e" }]}>
          <Feather name="clock" size={18} color="#22c55e" />
          <View style={{ flex: 1 }}>
            <Text style={[styles.clockedInTitle, { color: "#22c55e" }]}>ON DUTY</Text>
            <Text style={[styles.clockedInTime, { color: colors.foreground }]}>
              Clocked in {summary.clockInTime ? new Date(summary.clockInTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
            </Text>
          </View>
          <TouchableOpacity style={[styles.clockBtn, { backgroundColor: "#22c55e" }]} onPress={() => router.push("/(employee)/clock")}>
            <Text style={styles.clockBtnText}>View</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>THIS WEEK</Text>
        <View style={styles.statsGrid}>
          {[
            { label: "Hours Worked", value: `${parseFloat(summary?.hoursThisWeek as any ?? "0").toFixed(1)}h`, icon: "clock", color: colors.primary },
            { label: "Shifts Done", value: summary?.shiftsThisWeek ?? 0, icon: "calendar", color: colors.foreground },
            { label: "Upcoming", value: summary?.upcomingShifts ?? 0, icon: "arrow-right-circle", color: colors.accent },
            { label: "My Pay Est.", value: `$${parseFloat(summary?.estimatedPay as any ?? "0").toFixed(0)}`, icon: "dollar-sign", color: "#22c55e" },
          ].map(({ label, value, icon, color }) => (
            <View key={label} style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name={icon as any} size={18} color={color} />
              <Text style={[styles.statValue, { color }]}>{value}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      {!summary?.clockedIn && (
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.bigClockBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push("/(employee)/clock")}
          >
            <Feather name="clock" size={24} color={colors.primaryForeground} />
            <Text style={[styles.bigClockText, { color: colors.primaryForeground }]}>Clock In</Text>
          </TouchableOpacity>
        </View>
      )}

      {(summary?.nextShift) && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>NEXT SHIFT</Text>
          <TouchableOpacity
            style={[styles.nextShiftCard, { backgroundColor: colors.card, borderColor: colors.primary + "50" }]}
            onPress={() => router.push("/(employee)/shifts")}
          >
            <View style={[styles.shiftAccent, { backgroundColor: colors.primary }]} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[styles.shiftTitle, { color: colors.foreground }]}>{summary.nextShift.title}</Text>
              <Text style={[styles.shiftClient, { color: colors.primary }]}>{summary.nextShift.clientName}</Text>
              <View style={styles.shiftRow}>
                <Feather name="map-pin" size={13} color={colors.mutedForeground} />
                <Text style={[styles.shiftMeta, { color: colors.mutedForeground }]} numberOfLines={1}>{summary.nextShift.location}</Text>
              </View>
              <View style={styles.shiftRow}>
                <Feather name="clock" size={13} color={colors.mutedForeground} />
                <Text style={[styles.shiftMeta, { color: colors.mutedForeground }]}>
                  {new Date(summary.nextShift.startTime).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
            </View>
            <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      )}

      {(summary?.recentIncidents?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>MY RECENT INCIDENTS</Text>
          {summary!.recentIncidents.map((inc) => (
            <View key={inc.id} style={[styles.incCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.incRow}>
                <SeverityBadge severity={inc.severity} />
                <Text style={[styles.incTitle, { color: colors.foreground }]} numberOfLines={1}>{inc.title}</Text>
              </View>
              <Text style={[styles.incDate, { color: colors.mutedForeground }]}>{new Date(inc.occurredAt).toLocaleDateString()}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>QUICK ACTIONS</Text>
        <View style={styles.quickRow}>
          {[
            { label: "Report Incident", icon: "alert-triangle", route: "/(employee)/incidents" },
            { label: "My Shifts", icon: "calendar", route: "/(employee)/shifts" },
            { label: "My Profile", icon: "user", route: "/(employee)/profile" },
          ].map(({ label, icon, route }) => (
            <TouchableOpacity
              key={label}
              style={[styles.quickBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push(route as any)}
            >
              <Feather name={icon as any} size={20} color={colors.primary} />
              <Text style={[styles.quickLabel, { color: colors.foreground }]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: 1 },
  logoSmall: { width: 36, height: 36, borderRadius: 18 },
  greeting: { fontSize: 12, letterSpacing: 1 },
  name: { fontSize: 17, fontWeight: "700" },
  logoutBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  clockedInBanner: { flexDirection: "row", alignItems: "center", gap: 12, margin: 16, padding: 14, borderRadius: 12, borderWidth: 1 },
  clockedInTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2 },
  clockedInTime: { fontSize: 14, fontWeight: "600", marginTop: 2 },
  clockBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  clockBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statCard: { flex: 1, minWidth: "45%", padding: 14, borderRadius: 10, borderWidth: 1, alignItems: "center", gap: 5 },
  statValue: { fontSize: 24, fontWeight: "700" },
  statLabel: { fontSize: 11, textAlign: "center" },
  bigClockBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, padding: 18, borderRadius: 14 },
  bigClockText: { fontSize: 18, fontWeight: "800", letterSpacing: 1 },
  nextShiftCard: { flexDirection: "row", alignItems: "center", borderRadius: 12, borderWidth: 1, overflow: "hidden", gap: 14 },
  shiftAccent: { width: 4, alignSelf: "stretch" },
  shiftTitle: { fontSize: 15, fontWeight: "700" },
  shiftClient: { fontSize: 13, fontWeight: "600" },
  shiftRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  shiftMeta: { fontSize: 12, flex: 1 },
  incCard: { borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 8, gap: 5 },
  incRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  incTitle: { fontSize: 14, fontWeight: "600", flex: 1 },
  incDate: { fontSize: 12 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  quickRow: { flexDirection: "row", gap: 8 },
  quickBtn: { flex: 1, alignItems: "center", padding: 14, borderRadius: 10, borderWidth: 1, gap: 8 },
  quickLabel: { fontSize: 11, fontWeight: "600", textAlign: "center" },
});
