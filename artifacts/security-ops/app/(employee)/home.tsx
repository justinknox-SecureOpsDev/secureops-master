import React from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Image } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetEmployeeDashboardSummary, getGetEmployeeDashboardSummaryQueryKey, useGetLicenses, getGetLicensesQueryKey, useGetEmployee, getGetEmployeeQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Feather } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import EmergencyButton from "@/components/EmergencyButton";
import { apiRequest } from "@/utils/api";

function SeverityBadge({ severity }: { severity: string }) {
  const colors = useColors();
  const map: Record<string, string> = { low: colors.success, medium: colors.accent, high: "#f97316", critical: colors.destructive };
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
  const topPad = useTopPad();

  const { data: summary, isLoading, error, refetch } = useGetEmployeeDashboardSummary({
    query: { queryKey: getGetEmployeeDashboardSummaryQueryKey() }
  });

  // Pull the officer's own licenses so we can show a hard "you can't work
  // right now" banner when every license is expired or none exist. We
  // compute the worst-case nearest expiry too so the 60-day Texas DPS
  // window is visible in-app — the email is a reminder, but officers live
  // in the mobile app, so the warning belongs here too.
  const { data: myLicenses } = useGetLicenses({}, { query: { queryKey: getGetLicensesQueryKey({}) } });

  // Officer profile completeness. We pull the officer's own employee record and
  // check the fields they're expected to keep current themselves: contact info,
  // emergency contact, and the bank fields actually needed for ACH payout
  // (account number + routing). Bank *account name* is intentionally excluded —
  // it isn't required for WCSG's deposits. When anything is blank we surface a
  // tappable banner that lists exactly what's missing and opens edit-profile,
  // so officers can self-correct (and stay payable) without waiting on HR.
  const userId = user?.id;
  const { data: employeeProfile } = useGetEmployee(userId!, {
    query: { queryKey: getGetEmployeeQueryKey(userId!), enabled: !!userId },
  });
  const profileGaps = React.useMemo(() => {
    if (!employeeProfile) return [] as string[];
    const blank = (v: unknown) => !(typeof v === "string" && v.trim().length > 0);
    const gaps: string[] = [];
    if (blank(employeeProfile.phone)) gaps.push("phone number");
    if (blank(employeeProfile.address)) gaps.push("home address");
    if (blank(employeeProfile.emergencyContactName)) gaps.push("emergency contact name");
    if (blank(employeeProfile.emergencyContactPhone)) gaps.push("emergency contact phone");
    if (blank(employeeProfile.bankAccountNumber)) gaps.push("bank account number");
    if (blank(employeeProfile.bankBsb)) gaps.push("bank routing number");
    return gaps;
  }, [employeeProfile]);

  // Unread notifications badge. Polls cheaply every 30s while focused; also
  // refetched on every focus so the badge clears immediately after the user
  // visits the Notifications screen.
  const [unreadCount, setUnreadCount] = React.useState(0);
  const refreshUnread = React.useCallback(async () => {
    try {
      const r = await apiRequest("/me/notifications/unread-count") as { unreadCount: number };
      setUnreadCount(r?.unreadCount ?? 0);
    } catch { /* silent */ }
  }, []);
  useFocusEffect(React.useCallback(() => {
    void refreshUnread();
    const t = setInterval(() => { void refreshUnread(); }, 30_000);
    return () => clearInterval(t);
  }, [refreshUnread]));

  const licenseAlert = React.useMemo(() => {
    const list = (myLicenses ?? []) as Array<{ expiryDate?: string; type?: string }>;
    if (list.length === 0) {
      return { kind: "missing" as const, daysRemaining: 0, type: null as string | null };
    }
    const todayMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let nearest: { days: number; type: string | null; expired: boolean } | null = null;
    for (const l of list) {
      if (!l.expiryDate) continue;
      const days = Math.floor((new Date(l.expiryDate).getTime() - todayMs) / dayMs);
      const expired = days < 0;
      if (!nearest || days > nearest.days) {
        // We care about the MAX days remaining across all licenses: if any
        // one is still valid the officer can keep working. So we track the
        // "best" license here.
        nearest = { days, type: l.type ?? null, expired };
      }
    }
    if (!nearest) return null;
    if (nearest.expired) return { kind: "expired" as const, daysRemaining: nearest.days, type: nearest.type };
    if (nearest.days <= 60) return { kind: "expiring" as const, daysRemaining: nearest.days, type: nearest.type };
    return null;
  }, [myLicenses]);

  if (isLoading) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Image source={require("@/assets/images/logo.png")} style={styles.logoSmall} resizeMode="contain" />
        <View style={{ flex: 1 }} accessible accessibilityRole="header">
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Good day,</Text>
          <Text style={[styles.name, { color: colors.foreground }]}>{user?.firstName} {user?.lastName}</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/notifications" as any)}
          style={[styles.logoutBtn, { borderColor: colors.border, marginRight: 8 }]}
          accessibilityRole="button"
          accessibilityLabel={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          accessibilityHint="Opens your notifications"
        >
          <Feather name="bell" size={18} color={colors.mutedForeground} />
          {unreadCount > 0 && (
            <View style={[styles.bellBadge, { backgroundColor: colors.destructive, borderColor: colors.background }]}>
              <Text style={[styles.bellBadgeText, { color: colors.destructiveForeground }]}>{unreadCount > 99 ? "99+" : String(unreadCount)}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={logout}
          style={[styles.logoutBtn, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Sign out of your account"
        >
          <Feather name="log-out" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <EmergencyButton />

      {licenseAlert && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push("/license-renewal" as any)}
          accessibilityRole="button"
          accessibilityLabel={
            licenseAlert.kind === "missing"
              ? "No active license on file. Tap to start renewal."
              : licenseAlert.kind === "expired"
              ? "License expired, you cannot work. Tap to start renewal."
              : `Renew license, ${licenseAlert.daysRemaining} days left. Tap to start renewal.`
          }
          accessibilityHint="Opens the license renewal screen"
          style={[
            styles.licenseBanner,
            licenseAlert.kind === "expiring"
              ? { backgroundColor: colors.accent + "20", borderColor: colors.accent }
              : { backgroundColor: colors.destructive + "20", borderColor: colors.destructive },
          ]}
        >
          <Feather
            name={licenseAlert.kind === "expiring" ? "alert-circle" : "alert-octagon"}
            size={26}
            color={licenseAlert.kind === "expiring" ? colors.accent : colors.destructive}
          />
          <View style={{ flex: 1 }}>
            <Text
              style={[
                styles.licenseBannerTitle,
                { color: licenseAlert.kind === "expiring" ? colors.accent : colors.destructive },
              ]}
            >
              {licenseAlert.kind === "missing"
                ? "NO ACTIVE LICENSE ON FILE"
                : licenseAlert.kind === "expired"
                ? "LICENSE EXPIRED — CANNOT WORK"
                : `RENEW LICENSE — ${licenseAlert.daysRemaining} DAYS LEFT`}
            </Text>
            <Text style={[styles.licenseBannerBody, { color: colors.foreground }]}>
              {licenseAlert.kind === "missing"
                ? "You don't have a current security license on record. You can't clock in or claim shifts until HR has one on file."
                : licenseAlert.kind === "expired"
                ? "Your security license has expired. You can't clock in or claim shifts until you upload a renewed license."
                : `Texas DPS renewals are running long. Start your ${licenseAlert.type ?? "security"} license renewal now so it processes before the expiry date.`}
            </Text>
            <Text style={[styles.licenseBannerCta, { color: colors.primary }]}>Tap to start renewal →</Text>
          </View>
        </TouchableOpacity>
      )}

      {profileGaps.length > 0 && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => router.push("/edit-profile" as any)}
          accessibilityRole="button"
          accessibilityLabel={`Your profile is incomplete. Still needed: ${profileGaps.join(", ")}. Tap to complete your profile.`}
          accessibilityHint="Opens the edit profile screen"
          style={[styles.licenseBanner, { backgroundColor: colors.accent + "20", borderColor: colors.accent }]}
        >
          <Feather name="user-plus" size={26} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.licenseBannerTitle, { color: colors.accent }]}>COMPLETE YOUR PROFILE</Text>
            <Text style={[styles.licenseBannerBody, { color: colors.foreground }]}>
              Some details are still missing: {profileGaps.join(", ")}. Keeping these current helps us reach you and pay you on time.
            </Text>
            <Text style={[styles.licenseBannerCta, { color: colors.primary }]}>Tap to update your profile →</Text>
          </View>
        </TouchableOpacity>
      )}

      {summary?.activeTimeEntry && (
        <View style={[styles.clockedInBanner, { backgroundColor: colors.success + "20", borderColor: colors.success }]}>
          <Feather name="clock" size={18} color={colors.success} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.clockedInTitle, { color: colors.success }]}>ON DUTY</Text>
            <Text style={[styles.clockedInTime, { color: colors.foreground }]}>
              Clocked in {summary.activeTimeEntry.clockInTime ? new Date(summary.activeTimeEntry.clockInTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.clockBtn, { backgroundColor: colors.success }]}
            onPress={() => router.push("/(employee)/clock")}
            accessibilityRole="button"
            accessibilityLabel="View clock"
            accessibilityHint="Opens the clock screen to clock out"
          >
            <Text style={[styles.clockBtnText, { color: colors.successForeground }]}>View</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>THIS WEEK</Text>
        <View style={styles.statsGrid}>
          {[
            { label: "Hours Worked", value: `${parseFloat(summary?.hoursThisWeek as any ?? "0").toFixed(1)}h`, icon: "clock", color: colors.primary },
            { label: "Hours This Month", value: `${parseFloat(summary?.hoursThisMonth as any ?? "0").toFixed(1)}h`, icon: "calendar", color: colors.foreground },
            { label: "Upcoming Shifts", value: summary?.upcomingShifts?.length ?? 0, icon: "arrow-right-circle", color: colors.accent },
            { label: "Pending Accept", value: summary?.pendingAssignments?.length ?? 0, icon: "alert-circle", color: colors.success },
          ].map(({ label, value, icon, color }) => (
            <View key={label} style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name={icon as any} size={18} color={color} />
              <Text style={[styles.statValue, { color }]}>{value}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      {!summary?.activeTimeEntry && (
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.bigClockBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push("/(employee)/clock")}
            accessibilityRole="button"
            accessibilityLabel="Clock in"
            accessibilityHint="Opens the clock screen to start your shift"
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
            accessibilityRole="button"
            accessibilityLabel={`Next shift: ${summary.nextShift.title} at ${summary.nextShift.clientName}, ${summary.nextShift.location}, ${new Date(summary.nextShift.startTime).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
            accessibilityHint="Opens your shifts"
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

      {(summary?.myOpenIncidents ?? 0) > 0 && (
        <View style={styles.section}>
          <View style={[styles.incCard, { backgroundColor: colors.card, borderColor: colors.destructive + "60" }]}>
            <Feather name="alert-triangle" size={18} color={colors.destructive} />
            <Text style={[styles.incTitle, { color: colors.foreground }]}>{summary?.myOpenIncidents} open incident(s)</Text>
          </View>
        </View>
      )}
      {void SeverityBadge}

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
              accessibilityRole="button"
              accessibilityLabel={label}
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
  bellBadge: {
    position: "absolute", top: -4, right: -4,
    minWidth: 16, height: 16, borderRadius: 8, borderWidth: 1,
    paddingHorizontal: 4, alignItems: "center", justifyContent: "center",
  },
  bellBadgeText: { color: "#fff", fontSize: 9, fontWeight: "800", lineHeight: 12 },
  clockedInBanner: { flexDirection: "row", alignItems: "center", gap: 12, margin: 16, padding: 14, borderRadius: 12, borderWidth: 1 },
  licenseBanner: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: 12, borderWidth: 2 },
  licenseBannerTitle: { fontSize: 12, fontWeight: "800", letterSpacing: 1, marginBottom: 4 },
  licenseBannerBody: { fontSize: 13, lineHeight: 18 },
  licenseBannerCta: { fontSize: 12, fontWeight: "700", marginTop: 6 },
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
