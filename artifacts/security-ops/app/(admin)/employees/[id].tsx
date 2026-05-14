import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Alert } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetEmployee, getGetEmployeeQueryKey, useGetLicenses, getGetLicensesQueryKey, useUpdateEmployee } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

function InfoRow({ label, value, icon }: { label: string; value?: string | null; icon: string }) {
  const colors = useColors();
  if (!value) return null;
  return (
    <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
      <Feather name={icon as any} size={14} color={colors.mutedForeground} style={{ marginTop: 1 }} />
      <View style={styles.infoContent}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: colors.foreground }]}>{value}</Text>
      </View>
    </View>
  );
}

export default function EmployeeDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topPad = Platform.OS === "web" ? 67 : 0;

  const { data: employee, isLoading } = useGetEmployee(id!, {
    query: { queryKey: getGetEmployeeQueryKey(id!), enabled: !!id }
  });

  const { data: licenses } = useGetLicenses({
    params: { employeeId: id! },
    query: { queryKey: getGetLicensesQueryKey({ employeeId: id! }), enabled: !!id }
  });

  const updateEmployee = useUpdateEmployee();

  const toggleStatus = async () => {
    if (!employee) return;
    const newStatus = employee.status === "active" ? "inactive" : "active";
    Alert.alert("Update Status", `Set employee to ${newStatus}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm", onPress: async () => {
          await updateEmployee.mutateAsync({ id: id!, data: { status: newStatus as any } });
          queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(id!) });
        }
      }
    ]);
  };

  const getLicenseStatus = (expiryDate: string) => {
    const expiry = new Date(expiryDate);
    const now = new Date();
    if (expiry < now) return { color: colors.destructive, label: "EXPIRED" };
    if (expiry <= new Date(now.getTime() + 30 * 86400000)) return { color: colors.accent, label: "EXPIRING" };
    return { color: "#22c55e", label: "VALID" };
  };

  if (isLoading) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }
  if (!employee) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><Text style={{ color: colors.destructive }}>Employee not found</Text></View>;
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Employee Profile</Text>
        <TouchableOpacity
          onPress={toggleStatus}
          style={[styles.statusToggle, { borderColor: employee.status === "active" ? "#22c55e" : colors.accent }]}
        >
          <Text style={{ color: employee.status === "active" ? "#22c55e" : colors.accent, fontSize: 12, fontWeight: "600" }}>
            {employee.status.toUpperCase()}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.bigAvatar, { backgroundColor: colors.primary + "20" }]}>
          <Text style={[styles.bigAvatarText, { color: colors.primary }]}>{employee.firstName[0]}{employee.lastName[0]}</Text>
        </View>
        <Text style={[styles.heroName, { color: colors.foreground }]}>{employee.firstName} {employee.lastName}</Text>
        <Text style={[styles.heroRole, { color: colors.accent }]}>{employee.role.toUpperCase()}</Text>
        {employee.hourlyRate && (
          <Text style={[styles.heroRate, { color: colors.mutedForeground }]}>${parseFloat(employee.hourlyRate as any).toFixed(2)}/hr</Text>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>CONTACT INFO</Text>
        <InfoRow label="Email" value={employee.email} icon="mail" />
        <InfoRow label="Phone" value={employee.phone} icon="phone" />
        <InfoRow label="Address" value={employee.address} icon="map-pin" />
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>EMERGENCY CONTACT</Text>
        <InfoRow label="Name" value={employee.emergencyContactName} icon="user" />
        <InfoRow label="Phone" value={employee.emergencyContactPhone} icon="phone" />
      </View>

      {employee.bankAccountNumber && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>BANKING DETAILS</Text>
          <InfoRow label="Account Name" value={employee.bankAccountName} icon="credit-card" />
          <InfoRow label="Account Number" value={employee.bankAccountNumber ? "•••• " + employee.bankAccountNumber.slice(-4) : null} icon="credit-card" />
          <InfoRow label="BSB" value={employee.bankBsb} icon="credit-card" />
        </View>
      )}

      {(employee.skills?.length ?? 0) > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>SKILLS & CERTIFICATIONS</Text>
          <View style={styles.skillsWrap}>
            {employee.skills!.map((s) => (
              <View key={s} style={[styles.skillChip, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}>
                <Text style={[styles.skillText, { color: colors.primary }]}>{s}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>LICENCES ({licenses?.length ?? 0})</Text>
        {(licenses?.length ?? 0) === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No licences on file</Text>
        ) : (
          licenses!.map((lic) => {
            const licStatus = getLicenseStatus(lic.expiryDate);
            return (
              <View key={lic.id} style={[styles.licCard, { borderColor: colors.border }]}>
                <View style={styles.licRow}>
                  <Text style={[styles.licType, { color: colors.foreground }]}>{lic.type}</Text>
                  <View style={[styles.licBadge, { backgroundColor: licStatus.color + "20" }]}>
                    <Text style={[styles.licBadgeText, { color: licStatus.color }]}>{licStatus.label}</Text>
                  </View>
                </View>
                <Text style={[styles.licNum, { color: colors.mutedForeground }]}>{lic.licenseNumber}</Text>
                <Text style={[styles.licExpiry, { color: licStatus.color }]}>Expires: {lic.expiryDate}</Text>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { flex: 1, fontSize: 18, fontWeight: "700" },
  statusToggle: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  heroCard: { margin: 16, padding: 24, borderRadius: 14, borderWidth: 1, alignItems: "center", gap: 6 },
  bigAvatar: { width: 70, height: 70, borderRadius: 35, justifyContent: "center", alignItems: "center", marginBottom: 8 },
  bigAvatarText: { fontSize: 26, fontWeight: "700" },
  heroName: { fontSize: 22, fontWeight: "700" },
  heroRole: { fontSize: 12, fontWeight: "700", letterSpacing: 2 },
  heroRate: { fontSize: 14 },
  section: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, borderWidth: 1, padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  infoContent: { flex: 1 },
  infoLabel: { fontSize: 11, marginBottom: 2 },
  infoValue: { fontSize: 14 },
  skillsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  skillChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  skillText: { fontSize: 13, fontWeight: "500" },
  licCard: { paddingVertical: 12, borderBottomWidth: 1, gap: 3 },
  licRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  licType: { fontSize: 14, fontWeight: "600", flex: 1 },
  licBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
  licBadgeText: { fontSize: 10, fontWeight: "700" },
  licNum: { fontSize: 12 },
  licExpiry: { fontSize: 12, fontWeight: "600" },
  emptyText: { fontSize: 13, fontStyle: "italic" },
});
