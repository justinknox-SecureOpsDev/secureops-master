import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Image, Switch } from "react-native";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useGetMe, getGetMeQueryKey, useGetEmployee, getGetEmployeeQueryKey, useGetLicenses, getGetLicensesQueryKey } from "@workspace/api-client-react";
import { LicenseLevelBadge, levelLabel, levelColor } from "@/components/LicenseLevelBadge";
import { useAuth } from "@/contexts/AuthContext";
import { Feather } from "@expo/vector-icons";
import { isBiometricAvailable, isBiometricEnabled, setBiometricEnabled, promptBiometric } from "@/utils/biometric";

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

export default function EmployeeProfileScreen() {
  const colors = useColors();
  const router = useRouter();
  const { logout } = useAuth();
  const topPad = Platform.OS === "web" ? 67 : 0;
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const a = await isBiometricAvailable();
      const e = await isBiometricEnabled();
      if (!cancelled) { setBioAvailable(a); setBioOn(e); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function toggleBio(next: boolean) {
    setBioBusy(true);
    try {
      if (next) {
        const ok = await promptBiometric("Confirm biometric to enable faster sign-in");
        if (!ok) { setBioBusy(false); return; }
      }
      await setBiometricEnabled(next);
      setBioOn(next);
    } finally {
      setBioBusy(false);
    }
  }

  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const userId = (me as any)?.id as string | undefined;
  const { data: profile, isLoading } = useGetEmployee(userId!, {
    query: { queryKey: getGetEmployeeQueryKey(userId!), enabled: !!userId },
  });
  const maxLevel = (profile as any)?.maxLicenseLevel as number | null | undefined;

  const { data: licenses } = useGetLicenses({
    params: { employeeId: userId },
    query: { queryKey: getGetLicensesQueryKey({ employeeId: userId }), enabled: !!userId },
  } as any);

  const getLicenseStatus = (expiryDate: string) => {
    const expiry = new Date(expiryDate);
    const now = new Date();
    if (expiry < now) return { color: colors.destructive, label: "EXPIRED" };
    if (expiry <= new Date(now.getTime() + 30 * 86400000)) return { color: colors.accent, label: "EXPIRING" };
    return { color: "#22c55e", label: "VALID" };
  };

  if (isLoading) return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>My Profile</Text>
        <TouchableOpacity onPress={logout} style={[styles.logoutBtn, { borderColor: colors.destructive + "50" }]}>
          <Feather name="log-out" size={16} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.heroRow}>
          <Image source={require("@/assets/images/logo.jpeg")} style={styles.brandLogo} resizeMode="contain" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.heroName, { color: colors.foreground }]}>{profile?.firstName} {profile?.lastName}</Text>
            <View style={[styles.roleBadge, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "50" }]}>
              <Text style={[styles.roleText, { color: colors.primary }]}>SECURITY OFFICER</Text>
            </View>
          </View>
        </View>
        {profile?.hourlyRate && (
          <View style={[styles.rateBar, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Feather name="dollar-sign" size={14} color={colors.accent} />
            <Text style={[styles.rateText, { color: colors.accent }]}>${parseFloat(profile.hourlyRate as any).toFixed(2)}/hr</Text>
          </View>
        )}
        <View style={[styles.levelBar, { backgroundColor: levelColor(maxLevel, colors) + "15", borderColor: levelColor(maxLevel, colors) + "60" }]}>
          <Feather name="award" size={16} color={levelColor(maxLevel, colors)} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.mutedForeground, fontSize: 10, fontWeight: "700", letterSpacing: 1 }}>HIGHEST CURRENT CLEARANCE</Text>
            <Text style={{ color: levelColor(maxLevel, colors), fontSize: 16, fontWeight: "700", marginTop: 2 }}>
              {levelLabel(maxLevel ?? null)}
            </Text>
          </View>
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>CONTACT</Text>
        <InfoRow label="Email" value={profile?.email} icon="mail" />
        <InfoRow label="Phone" value={profile?.phone} icon="phone" />
        <InfoRow label="Address" value={profile?.address} icon="map-pin" />
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>EMERGENCY CONTACT</Text>
        <InfoRow label="Name" value={profile?.emergencyContactName} icon="user" />
        <InfoRow label="Phone" value={profile?.emergencyContactPhone} icon="phone" />
        {!profile?.emergencyContactName && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No emergency contact on file. Please contact admin.</Text>
        )}
      </View>

      {(profile?.skills?.length ?? 0) > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>SKILLS & QUALIFICATIONS</Text>
          <View style={styles.skillsWrap}>
            {profile!.skills!.map((s) => (
              <View key={s} style={[styles.skillChip, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}>
                <Text style={[styles.skillText, { color: colors.primary }]}>{s}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>MY LICENCES ({licenses?.length ?? 0})</Text>
        {(licenses?.length ?? 0) === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No licences on record</Text>
        ) : licenses!.map((lic: any) => {
          const ls = getLicenseStatus(lic.expiryDate);
          return (
            <View key={lic.id} style={[styles.licCard, { borderBottomColor: colors.border }]}>
              <View style={styles.licHeader}>
                <Text style={[styles.licType, { color: colors.foreground }]}>{lic.type}</Text>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {lic.level != null && <LicenseLevelBadge level={lic.level} size="sm" />}
                  <View style={[styles.badge, { backgroundColor: ls.color + "20", borderColor: ls.color }]}>
                    <Text style={[styles.badgeText, { color: ls.color }]}>{ls.label}</Text>
                  </View>
                </View>
              </View>
              <Text style={[styles.licNum, { color: colors.mutedForeground }]}>{lic.licenseNumber}</Text>
              <Text style={[styles.licExpiry, { color: ls.color, fontWeight: "600" }]}>Expires {lic.expiryDate}</Text>
            </View>
          );
        })}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>ACCOUNT</Text>
        <TouchableOpacity
          onPress={() => router.push("/edit-profile" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="edit-3" size={16} color={colors.primary} />
          <Text style={{ color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600" }}>Edit profile</Text>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push({ pathname: "/change-password" as any, params: { mode: "self" } })}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="lock" size={16} color={colors.primary} />
          <Text style={{ color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600" }}>Change password</Text>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        {bioAvailable && (
          <View style={[styles.actionRow, { borderBottomColor: "transparent" }]}>
            <Feather name="smile" size={16} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>
                {Platform.OS === "ios" ? "Face ID / Touch ID unlock" : "Fingerprint unlock"}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
                {bioOn ? "Enabled" : "Disabled"}
              </Text>
            </View>
            <Switch value={bioOn} onValueChange={toggleBio} disabled={bioBusy} />
          </View>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>WILLIAMS COUNCIL SECURITY GROUP</Text>
        <View style={styles.companyRow}>
          <Feather name="shield" size={14} color={colors.mutedForeground} />
          <Text style={[styles.companyText, { color: colors.mutedForeground }]}>Protection With Passion</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  logoutBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  logoutText: { fontSize: 13, fontWeight: "600" },
  heroCard: { margin: 16, padding: 18, borderRadius: 14, borderWidth: 1, gap: 12 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  brandLogo: { width: 60, height: 60, borderRadius: 30 },
  heroName: { fontSize: 20, fontWeight: "700" },
  roleBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6, borderWidth: 1, alignSelf: "flex-start" },
  roleText: { fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  rateBar: { flexDirection: "row", alignItems: "center", gap: 6, padding: 10, borderRadius: 8, borderWidth: 1 },
  levelBar: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 8, borderWidth: 1 },
  rateText: { fontSize: 15, fontWeight: "700" },
  section: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, borderWidth: 1, padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  infoLabel: { fontSize: 11, marginBottom: 2 },
  infoValue: { fontSize: 14 },
  skillsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  skillChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  skillText: { fontSize: 13 },
  licCard: { paddingVertical: 12, borderBottomWidth: 1, gap: 3 },
  licHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  licType: { fontSize: 14, fontWeight: "600", flex: 1 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  licNum: { fontSize: 12 },
  licExpiry: { fontSize: 12 },
  emptyText: { fontSize: 13, fontStyle: "italic" },
  companyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  companyText: { fontSize: 13 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: 1 },
});
