import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useCreatePaymentDiscrepancy } from "@workspace/api-client-react";
import type { PaymentDiscrepancyType } from "@workspace/api-client-react";

const TYPE_OPTIONS: { label: string; value: PaymentDiscrepancyType }[] = [
  { label: "Missed payment", value: "missed_payment" },
  { label: "Underpaid", value: "underpaid" },
  { label: "Missing hours", value: "missing_hours" },
  { label: "Incorrect rate", value: "incorrect_rate" },
  { label: "Other", value: "other" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeAmount(s: string): number | null {
  const t = s.trim().replace(/[$,]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN as unknown as number;
}

export default function PaymentDiscrepancyScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const mut = useCreatePaymentDiscrepancy();

  const [type, setType] = useState<PaymentDiscrepancyType>("missed_payment");
  const [shiftDate, setShiftDate] = useState("");
  const [payPeriodStart, setPayPeriodStart] = useState("");
  const [payPeriodEnd, setPayPeriodEnd] = useState("");
  const [expected, setExpected] = useState("");
  const [received, setReceived] = useState("");
  const [description, setDescription] = useState("");

  const submitting = mut.isPending;

  const submit = async () => {
    if (!description.trim()) {
      Alert.alert("Description required", "Please describe the discrepancy so we can investigate.");
      return;
    }
    for (const [label, val] of [["Shift date", shiftDate], ["Pay period start", payPeriodStart], ["Pay period end", payPeriodEnd]] as const) {
      if (val.trim() && !DATE_RE.test(val.trim())) {
        Alert.alert("Invalid date", `${label} must be in YYYY-MM-DD format.`);
        return;
      }
    }
    const exp = normalizeAmount(expected);
    const rec = normalizeAmount(received);
    if (Number.isNaN(exp) || Number.isNaN(rec)) {
      Alert.alert("Invalid amount", "Amounts must be positive numbers.");
      return;
    }

    try {
      await mut.mutateAsync({
        data: {
          discrepancyType: type,
          description: description.trim(),
          shiftDate: shiftDate.trim() || null,
          payPeriodStart: payPeriodStart.trim() || null,
          payPeriodEnd: payPeriodEnd.trim() || null,
          expectedAmount: exp,
          receivedAmount: rec,
        },
      });
      Alert.alert(
        "Report submitted",
        "Your payment discrepancy has been sent to the office. We'll review it and follow up.",
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (e) {
      Alert.alert("Could not submit", (e as Error).message ?? "Please try again in a moment.");
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          style={[styles.container, { backgroundColor: colors.background }]}
          contentContainerStyle={{ paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Feather name="chevron-left" size={22} color={colors.foreground} />
            </TouchableOpacity>
            <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">
              Report Pay Issue
            </Text>
            <View style={{ width: 32 }} />
          </View>

          <View style={{ padding: 16, gap: 18 }}>
            <Text style={[styles.intro, { color: colors.mutedForeground }]}>
              Something wrong with your pay? Tell us what happened and we'll look into it.
            </Text>

            <View style={styles.field}>
              <Text style={[styles.label, { color: colors.foreground }]}>Type of issue</Text>
              <View style={styles.chipRow}>
                {TYPE_OPTIONS.map((o) => {
                  const active = type === o.value;
                  return (
                    <TouchableOpacity
                      key={o.value}
                      onPress={() => setType(o.value)}
                      style={[
                        styles.chip,
                        { borderColor: active ? colors.accent : colors.border, backgroundColor: active ? colors.accent + "22" : colors.card },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={o.label}
                    >
                      <Text style={{ color: active ? colors.accent : colors.foreground, fontSize: 13, fontWeight: active ? "700" : "500" }}>
                        {o.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, { color: colors.foreground }]}>Shift date (optional)</Text>
              <TextInput
                value={shiftDate}
                onChangeText={setShiftDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                accessibilityLabel="Shift date"
              />
            </View>

            <View style={styles.row2}>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>Pay period start</Text>
                <TextInput
                  value={payPeriodStart}
                  onChangeText={setPayPeriodStart}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                  accessibilityLabel="Pay period start"
                />
              </View>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>Pay period end</Text>
                <TextInput
                  value={payPeriodEnd}
                  onChangeText={setPayPeriodEnd}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                  accessibilityLabel="Pay period end"
                />
              </View>
            </View>

            <View style={styles.row2}>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>Expected ($)</Text>
                <TextInput
                  value={expected}
                  onChangeText={setExpected}
                  placeholder="0.00"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                  style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                  accessibilityLabel="Expected amount in dollars"
                />
              </View>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>Received ($)</Text>
                <TextInput
                  value={received}
                  onChangeText={setReceived}
                  placeholder="0.00"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="decimal-pad"
                  style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                  accessibilityLabel="Received amount in dollars"
                />
              </View>
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, { color: colors.foreground }]}>What happened? *</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Describe the issue — which shift(s), how much you expected, and anything else that helps us investigate."
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={5}
                style={[styles.input, styles.textarea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                accessibilityLabel="Description of the discrepancy"
              />
            </View>

            <TouchableOpacity
              onPress={() => void submit()}
              disabled={submitting}
              style={[styles.submit, { backgroundColor: colors.primary, opacity: submitting ? 0.7 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Submit pay issue report"
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Submit report</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, justifyContent: "space-between" },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  intro: { fontSize: 13, lineHeight: 18 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  textarea: { minHeight: 110, textAlignVertical: "top" },
  row2: { flexDirection: "row", gap: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  submit: { paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 4 },
  submitText: { fontSize: 15, fontWeight: "700" },
});
