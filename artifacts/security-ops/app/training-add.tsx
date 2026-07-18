import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Platform, Alert, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { FeatureGate } from "@/components/FeatureGate";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function AddTrainingScreen() {
  return (
    <FeatureGate feature="trainings">
      <AddTrainingScreenInner />
    </FeatureGate>
  );
}

function AddTrainingScreenInner() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();

  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [issuingAuthority, setIssuingAuthority] = useState("");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim()) { Alert.alert("Title required"); return; }
    if (!type.trim()) { Alert.alert("Type required", "e.g. cpr, first_aid, fire_safety"); return; }
    if (issueDate && !DATE_RE.test(issueDate)) { Alert.alert("Issue date must be YYYY-MM-DD"); return; }
    if (expiryDate && !DATE_RE.test(expiryDate)) { Alert.alert("Expiry date must be YYYY-MM-DD"); return; }
    setBusy(true);
    try {
      await apiRequest("/me/trainings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: type.trim(),
          title: title.trim(),
          issuingAuthority: issuingAuthority.trim() || null,
          certificateNumber: certificateNumber.trim() || null,
          issueDate: issueDate || null,
          expiryDate: expiryDate || null,
        }),
      });
      router.back();
    } catch (e) {
      Alert.alert("Could not save", (e as Error).message ?? "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: topPad + 16, padding: 16, paddingBottom: 80 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ padding: 6, marginRight: 6 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700" }} accessibilityRole="header">Add training certificate</Text>
      </View>

      <Text style={[styles.label, { color: colors.mutedForeground }]}>Title</Text>
      <TextInput value={title} onChangeText={setTitle} placeholder="e.g. CPR/AED 2-year" placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]} accessibilityLabel="Title, required" />

      <Text style={[styles.label, { color: colors.mutedForeground }]}>Type / slug</Text>
      <TextInput value={type} onChangeText={setType} autoCapitalize="none" placeholder="e.g. cpr, first_aid, fire_safety" placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]} accessibilityLabel="Type or slug, required" accessibilityHint="Lowercase, no spaces. Sites match required training by this slug" />
      <Text style={[styles.help, { color: colors.mutedForeground }]}>Sites match required training by this slug. Lowercase, no spaces.</Text>

      <Text style={[styles.label, { color: colors.mutedForeground }]}>Issuing authority (optional)</Text>
      <TextInput value={issuingAuthority} onChangeText={setIssuingAuthority} placeholder="e.g. Red Cross" placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]} accessibilityLabel="Issuing authority, optional" />

      <Text style={[styles.label, { color: colors.mutedForeground }]}>Certificate # (optional)</Text>
      <TextInput value={certificateNumber} onChangeText={setCertificateNumber} placeholderTextColor={colors.mutedForeground} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]} accessibilityLabel="Certificate number, optional" />

      <Text style={[styles.label, { color: colors.mutedForeground }]}>Issued (YYYY-MM-DD, optional)</Text>
      <TextInput value={issueDate} onChangeText={setIssueDate} placeholder="2025-01-15" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]} accessibilityLabel="Issue date, optional" accessibilityHint="Format: year, month, day" />

      <Text style={[styles.label, { color: colors.mutedForeground }]}>Expires (YYYY-MM-DD, leave blank if perpetual)</Text>
      <TextInput value={expiryDate} onChangeText={setExpiryDate} placeholder="2027-01-15" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]} accessibilityLabel="Expiry date, optional" accessibilityHint="Format: year, month, day. Leave blank if perpetual" />

      <TouchableOpacity
        onPress={submit}
        disabled={busy}
        style={[styles.submit, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel="Save certificate"
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "700" }}>Save certificate</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: "700", marginTop: 14, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  help: { fontSize: 11, marginTop: 4 },
  submit: { marginTop: 24, paddingVertical: 14, alignItems: "center", borderRadius: 10 },
});
