import React, { useState, useEffect, useLayoutEffect } from "react";
import { useNavigation } from "expo-router";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Alert, Modal, TextInput, KeyboardAvoidingView } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetEmployee, getGetEmployeeQueryKey, useGetLicenses, getGetLicensesQueryKey, useUpdateEmployee, useCreateLicense } from "@workspace/api-client-react";
import { LicenseLevelBadge } from "@/components/LicenseLevelBadge";
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
  const topPad = useTopPad();
  const navigation = useNavigation();
  useLayoutEffect(() => { (navigation as any).setOptions?.({ headerShown: false }); }, [navigation]);

  const { data: employee, isLoading } = useGetEmployee(id!, {
    query: { queryKey: getGetEmployeeQueryKey(id!), enabled: !!id }
  });

  const { data: licenses } = useGetLicenses(
    { employeeId: id! },
    { query: { queryKey: getGetLicensesQueryKey({ employeeId: id! }), enabled: !!id } },
  );

  const updateEmployee = useUpdateEmployee();
  const [editOpen, setEditOpen] = useState(false);
  const [addLicOpen, setAddLicOpen] = useState(false);

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
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Employee Profile</Text>
        <TouchableOpacity
          onPress={() => setEditOpen(true)}
          style={[styles.editBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "15" }]}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${employee.firstName} ${employee.lastName}`}
        >
          <Feather name="edit-2" size={14} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "700" }}>Edit</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={toggleStatus}
          style={[styles.statusToggle, { borderColor: employee.status === "active" ? "#22c55e" : colors.accent }]}
          accessibilityRole="button"
          accessibilityLabel={`Status ${employee.status}. Tap to set ${employee.status === "active" ? "inactive" : "active"}`}
        >
          <Text style={{ color: employee.status === "active" ? "#22c55e" : colors.accent, fontSize: 12, fontWeight: "600" }}>
            {employee.status.toUpperCase()}
          </Text>
        </TouchableOpacity>
      </View>

      <EditEmployeeModal
        visible={editOpen}
        employee={employee}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(id!) });
        }}
      />

      <AddLicenseModal
        visible={addLicOpen}
        employeeId={id!}
        employeeName={`${employee.firstName} ${employee.lastName}`}
        onClose={() => setAddLicOpen(false)}
        onSaved={() => {
          setAddLicOpen(false);
          queryClient.invalidateQueries({ queryKey: getGetLicensesQueryKey({ employeeId: id! }) });
          queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(id!) });
        }}
      />

      <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.bigAvatar, { backgroundColor: colors.primary + "20" }]}>
          <Text style={[styles.bigAvatarText, { color: colors.primary }]}>{employee.firstName[0]}{employee.lastName[0]}</Text>
        </View>
        <Text style={[styles.heroName, { color: colors.foreground }]}>{employee.firstName} {employee.lastName}</Text>
        <Text style={[styles.heroRole, { color: colors.accent }]}>{employee.role.toUpperCase()}</Text>
        {employee.hourlyRate && (
          <Text style={[styles.heroRate, { color: colors.mutedForeground }]}>${parseFloat(employee.hourlyRate as any).toFixed(2)}/hr</Text>
        )}
        <View style={{ marginTop: 8 }}>
          <LicenseLevelBadge level={(employee as any).maxLicenseLevel} size="lg" />
        </View>
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
        <View style={styles.licSectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.accent, marginBottom: 0 }]}>LICENCES ({licenses?.length ?? 0})</Text>
          <TouchableOpacity
            onPress={() => setAddLicOpen(true)}
            style={[styles.addLicBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "15" }]}
            accessibilityRole="button"
            accessibilityLabel="Add licence"
          >
            <Feather name="plus" size={13} color={colors.primary} />
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "700" }}>Add</Text>
          </TouchableOpacity>
        </View>
        {(licenses?.length ?? 0) === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No licences on file</Text>
        ) : (
          licenses!.map((lic: any) => {
            const licStatus = getLicenseStatus(lic.expiryDate);
            return (
              <View key={lic.id} style={[styles.licCard, { borderColor: colors.border }]}>
                <View style={styles.licRow}>
                  <Text style={[styles.licType, { color: colors.foreground }]}>{lic.type}</Text>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {lic.level != null && <LicenseLevelBadge level={lic.level} size="sm" />}
                    <View style={[styles.licBadge, { backgroundColor: licStatus.color + "20" }]}>
                      <Text style={[styles.licBadgeText, { color: licStatus.color }]}>{licStatus.label}</Text>
                    </View>
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

function EditEmployeeModal({
  visible, employee, onClose, onSaved,
}: {
  visible: boolean;
  employee: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useColors();
  const updateEmployee = useUpdateEmployee();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    firstName: "", lastName: "", phone: "", address: "",
    hourlyRate: "", emergencyContactName: "", emergencyContactPhone: "",
  });

  useEffect(() => {
    if (employee) {
      setForm({
        firstName: employee.firstName ?? "",
        lastName: employee.lastName ?? "",
        phone: employee.phone ?? "",
        address: employee.address ?? "",
        hourlyRate: employee.hourlyRate != null ? String(employee.hourlyRate) : "",
        emergencyContactName: employee.emergencyContactName ?? "",
        emergencyContactPhone: employee.emergencyContactPhone ?? "",
      });
    }
  }, [employee, visible]);

  const handleSave = async () => {
    if (!employee) return;
    setSaving(true);
    try {
      const payload: any = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        emergencyContactName: form.emergencyContactName.trim(),
        emergencyContactPhone: form.emergencyContactPhone.trim(),
      };
      const rate = parseFloat(form.hourlyRate);
      if (!isNaN(rate) && rate >= 0) payload.hourlyRate = rate;
      await updateEmployee.mutateAsync({ id: employee.id, data: payload });
      onSaved();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Could not save changes.";
      if (Platform.OS === "web") window.alert(msg);
      else Alert.alert("Save failed", msg);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: keyof typeof form) => (v: string) => setForm((prev) => ({ ...prev, [key]: v }));

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="formSheet">
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} disabled={saving} accessibilityRole="button" accessibilityLabel="Cancel editing">
            <Text style={{ color: colors.mutedForeground, fontSize: 16 }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: colors.foreground }]} accessibilityRole="header">Edit Employee</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving} accessibilityRole="button" accessibilityLabel="Save changes" accessibilityState={{ disabled: saving, busy: saving }}>
            {saving
              ? <ActivityIndicator color={colors.primary} />
              : <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "700" }}>Save</Text>}
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
            <Text style={[styles.modalSectionTitle, { color: colors.accent }]}>CONTACT INFO</Text>
            <EditField colors={colors} label="First name" value={form.firstName} onChangeText={update("firstName")} autoCapitalize="words" />
            <EditField colors={colors} label="Last name" value={form.lastName} onChangeText={update("lastName")} autoCapitalize="words" />
            <EditField colors={colors} label="Phone" value={form.phone} onChangeText={update("phone")} keyboardType="phone-pad" />
            <EditField colors={colors} label="Address" value={form.address} onChangeText={update("address")} autoCapitalize="words" />

            <Text style={[styles.modalSectionTitle, { color: colors.accent, marginTop: 16 }]}>PAY</Text>
            <EditField colors={colors} label="Hourly rate (USD)" value={form.hourlyRate} onChangeText={update("hourlyRate")} keyboardType="decimal-pad" />

            <Text style={[styles.modalSectionTitle, { color: colors.accent, marginTop: 16 }]}>EMERGENCY CONTACT</Text>
            <EditField colors={colors} label="Contact name" value={form.emergencyContactName} onChangeText={update("emergencyContactName")} autoCapitalize="words" />
            <EditField colors={colors} label="Contact phone" value={form.emergencyContactPhone} onChangeText={update("emergencyContactPhone")} keyboardType="phone-pad" />

            <Text style={[styles.modalNote, { color: colors.mutedForeground }]}>
              Email and banking details are edited from the admin portal. Add licences from the Licences section.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function EditField({
  colors, label, value, onChangeText, keyboardType, autoCapitalize,
}: {
  colors: ReturnType<typeof useColors>;
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: "default" | "phone-pad" | "decimal-pad";
  autoCapitalize?: "none" | "sentences" | "words";
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        placeholderTextColor={colors.mutedForeground}
        style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
        accessibilityLabel={label}
      />
    </View>
  );
}

function AddLicenseModal({
  visible, employeeId, employeeName, onClose, onSaved,
}: {
  visible: boolean;
  employeeId: string;
  employeeName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useColors();
  const createLicense = useCreateLicense();
  const [form, setForm] = useState<{ type: string; level: 2 | 3 | 4; licenseNumber: string; issueDate: string; expiryDate: string; issuingAuthority: string }>({
    type: "", level: 2, licenseNumber: "", issueDate: "", expiryDate: "", issuingAuthority: "",
  });
  const set = (k: keyof typeof form) => (v: any) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (visible) setForm({ type: "", level: 2, licenseNumber: "", issueDate: "", expiryDate: "", issuingAuthority: "" });
  }, [visible]);

  const handleSave = async () => {
    if (!form.type.trim() || !form.licenseNumber.trim() || !form.expiryDate.trim()) {
      const msg = "Licence type, number and expiry date are required.";
      if (Platform.OS === "web") window.alert(msg); else Alert.alert("Missing fields", msg);
      return;
    }
    try {
      await createLicense.mutateAsync({
        data: {
          employeeId,
          type: form.type.trim(),
          level: form.level,
          licenseNumber: form.licenseNumber.trim(),
          expiryDate: form.expiryDate.trim(),
          issueDate: form.issueDate.trim() || undefined,
          issuingAuthority: form.issuingAuthority.trim() || undefined,
        } as any,
      });
      onSaved();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || "Could not add licence.";
      if (Platform.OS === "web") window.alert(msg); else Alert.alert("Save failed", msg);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="formSheet">
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} disabled={createLicense.isPending} accessibilityRole="button" accessibilityLabel="Cancel">
            <Text style={{ color: colors.mutedForeground, fontSize: 16 }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: colors.foreground }]} accessibilityRole="header">Add Licence</Text>
          <TouchableOpacity onPress={handleSave} disabled={createLicense.isPending} accessibilityRole="button" accessibilityLabel="Save licence" accessibilityState={{ disabled: createLicense.isPending, busy: createLicense.isPending }}>
            {createLicense.isPending ? <ActivityIndicator color={colors.primary} /> : <Text style={{ color: colors.primary, fontSize: 16, fontWeight: "700" }}>Save</Text>}
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
            <Text style={[styles.modalNote, { color: colors.mutedForeground, marginTop: 0, marginBottom: 16 }]}>For {employeeName}</Text>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Licence level</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
              {([2, 3, 4] as const).map((lv) => (
                <TouchableOpacity
                  key={lv}
                  style={[styles.lvlChip, {
                    borderColor: form.level === lv ? colors.primary : colors.border,
                    backgroundColor: form.level === lv ? colors.primary + "20" : "transparent",
                  }]}
                  onPress={() => set("level")(lv)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: form.level === lv }}
                  accessibilityLabel={lv === 4 ? "Level 4 PPO" : `Level ${lv}`}
                >
                  <Text style={{ color: form.level === lv ? colors.primary : colors.foreground, fontWeight: "700", fontSize: 13 }}>
                    {lv === 4 ? "L4 / PPO" : `Level ${lv}`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <EditField colors={colors} label="Licence type" value={form.type} onChangeText={set("type")} autoCapitalize="words" />
            <EditField colors={colors} label="Licence number" value={form.licenseNumber} onChangeText={set("licenseNumber")} />
            <EditField colors={colors} label="Issuing authority" value={form.issuingAuthority} onChangeText={set("issuingAuthority")} autoCapitalize="words" />
            <EditField colors={colors} label="Issue date (YYYY-MM-DD)" value={form.issueDate} onChangeText={set("issueDate")} />
            <EditField colors={colors} label="Expiry date (YYYY-MM-DD)" value={form.expiryDate} onChangeText={set("expiryDate")} />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { flex: 1, fontSize: 18, fontWeight: "700" },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  statusToggle: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  modalTitle: { fontSize: 16, fontWeight: "700" },
  modalSectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  modalNote: { fontSize: 12, fontStyle: "italic", marginTop: 20, textAlign: "center" },
  fieldLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
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
  licSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  addLicBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  lvlChip: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1.5, alignItems: "center" },
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
