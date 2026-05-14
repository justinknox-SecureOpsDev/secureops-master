import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert, Platform, Switch } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useCreateShift, getGetShiftsQueryKey } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";

function Field({ label, value, onChangeText, placeholder, keyboardType, autoCapitalize, required }: any) {
  const colors = useColors();
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}{required ? " *" : ""}</Text>
      <TextInput
        style={[styles.fieldInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType || "default"}
        autoCapitalize={autoCapitalize || "sentences"}
      />
    </View>
  );
}

export default function CreateShiftScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const createShift = useCreateShift();
  const topPad = Platform.OS === "web" ? 67 : 0;

  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  const endTime = new Date(nextHour);
  endTime.setHours(endTime.getHours() + 8);

  const fmt = (d: Date) => d.toISOString().slice(0, 16);

  const [form, setForm] = useState({
    title: "", clientName: "", location: "", notes: "",
    startTime: fmt(nextHour), endTime: fmt(endTime),
    hourlyRate: "", billableRate: "", breakMinutes: "30",
    isRepeat: false, repeatPattern: "",
  });
  const set = (key: string) => (val: any) => setForm((f) => ({ ...f, [key]: val }));

  const handleCreate = async () => {
    if (!form.title || !form.clientName || !form.location || !form.startTime || !form.endTime || !form.hourlyRate) {
      Alert.alert("Missing Fields", "Title, client, location, times and hourly rate are required.");
      return;
    }
    try {
      await createShift.mutateAsync({
        data: {
          title: form.title, clientName: form.clientName,
          location: form.location, notes: form.notes || undefined,
          startTime: new Date(form.startTime).toISOString(),
          endTime: new Date(form.endTime).toISOString(),
          hourlyRate: parseFloat(form.hourlyRate),
          billableRate: form.billableRate ? parseFloat(form.billableRate) : undefined,
          breakMinutes: form.breakMinutes ? parseInt(form.breakMinutes) : undefined,
          isRepeat: form.isRepeat,
          repeatPattern: form.isRepeat ? form.repeatPattern || undefined : undefined,
        }
      });
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
      Alert.alert("Success", "Shift created.");
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to create shift");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Create Shift</Text>
      </View>

      <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        <Text style={[styles.sectionLabel, { color: colors.accent }]}>SHIFT DETAILS</Text>
        <Field label="Shift Title" value={form.title} onChangeText={set("title")} placeholder="Night Security — CBD" required />
        <Field label="Client / Site Name" value={form.clientName} onChangeText={set("clientName")} placeholder="Crown Casino" required />
        <Field label="Location" value={form.location} onChangeText={set("location")} placeholder="8 Whiteman St, Southbank" required />
        <Field label="Notes" value={form.notes} onChangeText={set("notes")} placeholder="Bring high-vis vest" />

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>SCHEDULE</Text>
        <Field label="Start Time (YYYY-MM-DDTHH:MM)" value={form.startTime} onChangeText={set("startTime")} placeholder="2025-06-01T20:00" autoCapitalize="none" required />
        <Field label="End Time (YYYY-MM-DDTHH:MM)" value={form.endTime} onChangeText={set("endTime")} placeholder="2025-06-02T04:00" autoCapitalize="none" required />
        <Field label="Break (minutes)" value={form.breakMinutes} onChangeText={set("breakMinutes")} placeholder="30" keyboardType="numeric" autoCapitalize="none" />

        <View style={[styles.switchRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="repeat" size={16} color={colors.mutedForeground} />
          <Text style={[styles.switchLabel, { color: colors.foreground }]}>Repeating Shift</Text>
          <Switch
            value={form.isRepeat}
            onValueChange={set("isRepeat")}
            trackColor={{ false: colors.border, true: colors.primary + "80" }}
            thumbColor={form.isRepeat ? colors.primary : colors.mutedForeground}
          />
        </View>
        {form.isRepeat && (
          <Field label="Repeat Pattern" value={form.repeatPattern} onChangeText={set("repeatPattern")} placeholder="e.g. Every Friday" />
        )}

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>RATES</Text>
        <Field label="Employee Pay Rate ($/hr)" value={form.hourlyRate} onChangeText={set("hourlyRate")} placeholder="38.50" keyboardType="decimal-pad" autoCapitalize="none" required />
        <Field label="Client Billable Rate ($/hr)" value={form.billableRate} onChangeText={set("billableRate")} placeholder="75.00" keyboardType="decimal-pad" autoCapitalize="none" />

        <TouchableOpacity
          style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: createShift.isPending ? 0.7 : 1 }]}
          onPress={handleCreate}
          disabled={createShift.isPending}
        >
          {createShift.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <>
              <Feather name="calendar" size={18} color={colors.primaryForeground} />
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Create Shift</Text>
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
  switchRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 8, borderWidth: 1, marginBottom: 14 },
  switchLabel: { flex: 1, fontSize: 14 },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, padding: 16, borderRadius: 12, marginTop: 24 },
  submitText: { fontSize: 16, fontWeight: "700" },
});
