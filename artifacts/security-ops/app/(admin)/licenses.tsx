import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform, Modal, TextInput } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetLicenses, getGetLicensesQueryKey, useCreateLicense, useGetEmployees, getGetEmployeesQueryKey, useGetAdminLicenseRenewals, getGetAdminLicenseRenewalsQueryKey } from "@workspace/api-client-react";
import { LicenseLevelBadge } from "@/components/LicenseLevelBadge";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";

const TYPE_FILTERS = ["all", "expiring", "expired"] as const;

export default function AdminLicensesScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const topPad = useTopPad();

  const [form, setForm] = useState<{ employeeId: string; type: string; level: 2 | 3 | 4 | null; licenseNumber: string; issueDate: string; expiryDate: string; issuingAuthority: string }>({ employeeId: "", type: "", level: 2, licenseNumber: "", issueDate: "", expiryDate: "", issuingAuthority: "" });
  const set = (k: string) => (v: any) => setForm((f) => ({ ...f, [k]: v }));

  const lParams: any = filter === "expiring"
    ? { status: "expiring_soon" }
    : filter === "expired"
    ? { status: "expired" }
    : {};
  const { data: licenses, isLoading, error, refetch } = useGetLicenses(
    lParams,
    { query: { queryKey: getGetLicensesQueryKey(lParams) } },
  );

  const { data: employees } = useGetEmployees(
    { status: "active" as any },
    { query: { queryKey: getGetEmployeesQueryKey({ status: "active" as any }) } },
  );

  const { data: pendingRenewals } = useGetAdminLicenseRenewals(
    { status: "pending" },
    { query: { queryKey: getGetAdminLicenseRenewalsQueryKey({ status: "pending" }) } },
  );
  const pendingCount = pendingRenewals?.length ?? 0;

  const createLicense = useCreateLicense();

  const getLicenseStatus = (expiryDate: string) => {
    const expiry = new Date(expiryDate);
    const now = new Date();
    if (expiry < now) return { color: colors.destructive, label: "EXPIRED" };
    if (expiry <= new Date(now.getTime() + 30 * 86400000)) return { color: colors.accent, label: "EXPIRING SOON" };
    return { color: "#22c55e", label: "VALID" };
  };

  const handleCreate = async () => {
    if (!form.employeeId || !form.type || !form.licenseNumber || !form.expiryDate) {
      Alert.alert("Missing Fields", "Employee, type, licence number and expiry date are required.");
      return;
    }
    try {
      await createLicense.mutateAsync({ data: { ...form, level: form.level ?? undefined, issueDate: form.issueDate || undefined, issuingAuthority: form.issuingAuthority || undefined } as any });
      queryClient.invalidateQueries({ queryKey: getGetLicensesQueryKey() });
      setShowAdd(false);
      setForm({ employeeId: "", type: "", level: 2, licenseNumber: "", issueDate: "", expiryDate: "", issuingAuthority: "" });
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to create licence");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Licences</Text>
        <TouchableOpacity
          style={[styles.approvalsBtn, { borderColor: colors.border }]}
          onPress={() => router.push("/(admin)/license-approvals" as any)}
          accessibilityRole="button"
          accessibilityLabel={pendingCount > 0 ? `Licence approvals, ${pendingCount} pending` : "Licence approvals"}
        >
          <Feather name="check-square" size={16} color={colors.foreground} />
          <Text style={[styles.approvalsText, { color: colors.foreground }]}>Approvals</Text>
          {pendingCount > 0 && (
            <View style={[styles.countPill, { backgroundColor: colors.primary }]}>
              <Text style={[styles.countPillText, { color: colors.primaryForeground }]}>{pendingCount > 99 ? "99+" : pendingCount}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={[styles.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)} accessibilityRole="button" accessibilityLabel="Add licence">
          <Feather name="plus" size={18} color={colors.primaryForeground} />
        </TouchableOpacity>
      </View>

      <View style={styles.filterRow}>
        {TYPE_FILTERS.map((f) => (
          <TouchableOpacity key={f} style={[styles.filterChip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]} onPress={() => setFilter(f)} accessibilityRole="button" accessibilityState={{ selected: filter === f }} accessibilityLabel={`Filter ${f.charAt(0).toUpperCase() + f.slice(1)}`}>
            <Text style={[styles.filterText, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load licences</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Retry loading licences"><Text style={{ color: colors.primary }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={licenses ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(licenses && licenses.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="award" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No licences found</Text>
            </View>
          }
          renderItem={({ item }) => {
            const licStatus = getLicenseStatus(item.expiryDate);
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: licStatus.color === colors.destructive ? colors.destructive + "50" : colors.border }]}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.licType, { color: colors.foreground }]}>{item.type}</Text>
                    <Text style={[styles.empName, { color: colors.primary }]}>{item.employeeName}</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                    {(item as any).level != null && <LicenseLevelBadge level={(item as any).level} size="sm" />}
                    <View style={[styles.badge, { backgroundColor: licStatus.color + "20", borderColor: licStatus.color }]}>
                      <Text style={[styles.badgeText, { color: licStatus.color }]}>{licStatus.label}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.detailRow}>
                  <Feather name="hash" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.detailText, { color: colors.mutedForeground }]}>{item.licenseNumber}</Text>
                </View>
                {item.issuingAuthority && (
                  <View style={styles.detailRow}>
                    <Feather name="briefcase" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.detailText, { color: colors.mutedForeground }]}>{item.issuingAuthority}</Text>
                  </View>
                )}
                <View style={styles.dateRow}>
                  {item.issueDate && (
                    <View style={styles.detailRow}>
                      <Feather name="calendar" size={13} color={colors.mutedForeground} />
                      <Text style={[styles.detailText, { color: colors.mutedForeground }]}>Issued: {item.issueDate}</Text>
                    </View>
                  )}
                  <View style={[styles.detailRow, { marginLeft: 12 }]}>
                    <Feather name="clock" size={13} color={licStatus.color} />
                    <Text style={[styles.detailText, { color: licStatus.color, fontWeight: "600" }]}>Expires: {item.expiryDate}</Text>
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      {showAdd && (
        <Modal transparent animationType="slide" onRequestClose={() => setShowAdd(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Add Licence</Text>
                <TouchableOpacity onPress={() => setShowAdd(false)} accessibilityRole="button" accessibilityLabel="Close"><Feather name="x" size={20} color={colors.mutedForeground} /></TouchableOpacity>
              </View>
              <KeyboardAwareScrollViewCompat style={{ maxHeight: 420 }}>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Employee *</Text>
                <View style={[styles.picker, { borderColor: colors.border }]}>
                  {(employees ?? []).map((e) => (
                    <TouchableOpacity key={e.id} style={[styles.pickerItem, { backgroundColor: form.employeeId === e.id ? colors.primary + "20" : "transparent" }]} onPress={() => set("employeeId")(e.id)} accessibilityRole="button" accessibilityState={{ selected: form.employeeId === e.id }} accessibilityLabel={`Employee ${e.firstName} ${e.lastName}`}>
                      <Text style={[styles.pickerText, { color: form.employeeId === e.id ? colors.primary : colors.foreground }]}>{e.firstName} {e.lastName}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Licence Level *</Text>
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
                  {([1, 2, 3, 4] as const).map((lv) => (
                    <TouchableOpacity
                      key={lv}
                      style={[styles.lvlChip, {
                        borderColor: form.level === lv ? colors.primary : colors.border,
                        backgroundColor: form.level === lv ? colors.primary + "20" : "transparent",
                      }]}
                      onPress={() => set("level")(lv)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: form.level === lv }}
                      accessibilityLabel={lv === 1 ? "Level 1 Support Staff" : lv === 4 ? "Level 4 PPO" : `Level ${lv}`}
                    >
                      <Text style={{ color: form.level === lv ? colors.primary : colors.foreground, fontWeight: "700", fontSize: 13 }}>
                        {lv === 1 ? "L1 Support" : lv === 4 ? "L4 / PPO" : `Level ${lv}`}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {[
                  { label: "Licence Type *", key: "type", placeholder: "Security Licence (SIA)" },
                  { label: "Licence Number *", key: "licenseNumber", placeholder: "SIA-123456789" },
                  { label: "Issued Date (YYYY-MM-DD)", key: "issueDate", placeholder: "2023-01-15" },
                  { label: "Expiry Date *  (YYYY-MM-DD)", key: "expiryDate", placeholder: "2026-01-14" },
                  { label: "Issuing Authority", key: "issuingAuthority", placeholder: "Security Industry Authority" },
                ].map(({ label, key, placeholder }) => (
                  <View key={key} style={{ marginBottom: 12 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
                    <TextInput
                      style={[styles.fieldInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                      value={(form as any)[key]}
                      onChangeText={set(key)}
                      placeholder={placeholder}
                      placeholderTextColor={colors.mutedForeground}
                      autoCapitalize="none"
                      accessibilityLabel={label}
                    />
                  </View>
                ))}
              </KeyboardAwareScrollViewCompat>
              <TouchableOpacity style={[styles.submitBtn, { backgroundColor: colors.primary }]} onPress={handleCreate} disabled={createLicense.isPending} accessibilityRole="button" accessibilityLabel="Save licence" accessibilityState={{ disabled: createLicense.isPending, busy: createLicense.isPending }}>
                {createLicense.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Save Licence</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { flex: 1, fontSize: 22, fontWeight: "700" },
  addBtn: { width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  approvalsBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, borderWidth: 1 },
  approvalsText: { fontSize: 13, fontWeight: "600" },
  countPill: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, justifyContent: "center", alignItems: "center" },
  countPillText: { fontSize: 10, fontWeight: "800" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  licType: { fontSize: 15, fontWeight: "700" },
  empName: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  detailText: { fontSize: 12 },
  dateRow: { flexDirection: "row", flexWrap: "wrap" },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  modalOverlay: { flex: 1, backgroundColor: "#000000bb", justifyContent: "flex-end" },
  modalCard: { borderRadius: 20, borderWidth: 1, padding: 20, gap: 14, margin: 12 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  fieldLabel: { fontSize: 12, marginBottom: 5, fontWeight: "500" },
  fieldInput: { height: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14, marginBottom: 2 },
  picker: { borderWidth: 1, borderRadius: 8, marginBottom: 12, maxHeight: 140, overflow: "hidden" },
  pickerItem: { paddingVertical: 10, paddingHorizontal: 12 },
  pickerText: { fontSize: 14 },
  lvlChip: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1.5, alignItems: "center" },
  submitBtn: { paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  submitText: { fontWeight: "700", fontSize: 15 },
});
