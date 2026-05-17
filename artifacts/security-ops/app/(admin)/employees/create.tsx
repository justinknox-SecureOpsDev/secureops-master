import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert, Platform } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useCreateEmployee, getGetEmployeesQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";

function Field({ label, value, onChangeText, placeholder, keyboardType, secureTextEntry, autoCapitalize }: any) {
  const colors = useColors();
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType || "default"}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize || "words"}
      />
    </View>
  );
}

export default function CreateEmployeeScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const createEmployee = useCreateEmployee();
  const topPad = useTopPad();

  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", password: "", phone: "",
    role: "employee" as "admin" | "employee",
    hourlyRate: "", address: "",
    emergencyContactName: "", emergencyContactPhone: "",
    skills: "",
  });

  const set = (key: string) => (val: string) => setForm((f) => ({ ...f, [key]: val }));

  const handleCreate = async () => {
    if (!form.firstName || !form.lastName || !form.email || !form.password) {
      Alert.alert("Missing Fields", "First name, last name, email and password are required.");
      return;
    }
    try {
      await createEmployee.mutateAsync({
        data: {
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          password: form.password,
          phone: form.phone || undefined,
          role: form.role,
          hourlyRate: form.hourlyRate ? parseFloat(form.hourlyRate) : undefined,
          address: form.address || undefined,
          emergencyContactName: form.emergencyContactName || undefined,
          emergencyContactPhone: form.emergencyContactPhone || undefined,
          skills: form.skills ? form.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        }
      });
      queryClient.invalidateQueries({ queryKey: getGetEmployeesQueryKey() });
      Alert.alert("Success", "Employee created successfully.");
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to create employee");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Add Employee</Text>
      </View>

      <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        <Text style={[styles.sectionLabel, { color: colors.accent }]}>PERSONAL DETAILS</Text>
        <Field label="First Name *" value={form.firstName} onChangeText={set("firstName")} placeholder="John" />
        <Field label="Last Name *" value={form.lastName} onChangeText={set("lastName")} placeholder="Smith" />
        <Field label="Email *" value={form.email} onChangeText={set("email")} placeholder="john@example.com" keyboardType="email-address" autoCapitalize="none" />
        <Field label="Password *" value={form.password} onChangeText={set("password")} placeholder="Minimum 8 characters" secureTextEntry autoCapitalize="none" />
        <Field label="Phone" value={form.phone} onChangeText={set("phone")} placeholder="+61400000000" keyboardType="phone-pad" autoCapitalize="none" />

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>ROLE</Text>
        <View style={styles.roleRow}>
          {(["employee", "admin"] as const).map((r) => (
            <TouchableOpacity
              key={r}
              style={[styles.roleChip, { borderColor: form.role === r ? colors.primary : colors.border, backgroundColor: form.role === r ? colors.primary + "20" : "transparent" }]}
              onPress={() => set("role")(r)}
            >
              <Feather name={r === "admin" ? "shield" : "user"} size={16} color={form.role === r ? colors.primary : colors.mutedForeground} />
              <Text style={[styles.roleText, { color: form.role === r ? colors.primary : colors.mutedForeground }]}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>EMPLOYMENT</Text>
        <Field label="Hourly Rate ($)" value={form.hourlyRate} onChangeText={set("hourlyRate")} placeholder="38.50" keyboardType="decimal-pad" autoCapitalize="none" />
        <Field label="Skills (comma separated)" value={form.skills} onChangeText={set("skills")} placeholder="crowd control, first aid, CCTV" autoCapitalize="none" />

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>ADDRESS</Text>
        <Field label="Address" value={form.address} onChangeText={set("address")} placeholder="12 Main St, Melbourne VIC 3000" autoCapitalize="sentences" />

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>EMERGENCY CONTACT</Text>
        <Field label="Contact Name" value={form.emergencyContactName} onChangeText={set("emergencyContactName")} placeholder="Jane Smith" />
        <Field label="Contact Phone" value={form.emergencyContactPhone} onChangeText={set("emergencyContactPhone")} placeholder="+61422333444" keyboardType="phone-pad" autoCapitalize="none" />

        <TouchableOpacity
          style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: createEmployee.isPending ? 0.7 : 1 }]}
          onPress={handleCreate}
          disabled={createEmployee.isPending}
        >
          {createEmployee.isPending ? <ActivityIndicator color="#fff" /> : (
            <>
              <Feather name="user-plus" size={18} color="#fff" />
              <Text style={styles.submitText}>Create Employee</Text>
            </>
          )}
        </TouchableOpacity>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  fieldWrap: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, marginBottom: 6, fontWeight: "500" },
  fieldInput: { height: 46, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, fontSize: 15 },
  roleRow: { flexDirection: "row", gap: 10, marginBottom: 4 },
  roleChip: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
  roleText: { fontSize: 14, fontWeight: "600" },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, padding: 16, borderRadius: 12, marginTop: 24 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
