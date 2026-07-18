import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform, KeyboardAvoidingView,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { notify } from "@/utils/confirm";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { FeatureGate } from "@/components/FeatureGate";

type Row = {
  id: string;
  reportDate: string;
  submittedAt: string;
  summary: string;
  visitorsCount: number;
  patrolsCount: number;
  siteName: string | null;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function DarScreen() {
  return (
    <FeatureGate feature="dar">
      <DarScreenInner />
    </FeatureGate>
  );
}

function DarScreenInner() {
  const colors = useColors();
  const router = useRouter();

  const [summary, setSummary] = useState("");
  const [observations, setObservations] = useState("");
  const [visitors, setVisitors] = useState("0");
  const [patrols, setPatrols] = useState("0");
  const [incidents, setIncidents] = useState("");
  const [weather, setWeather] = useState("");
  const [signature, setSignature] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest("/me/dar");
      setRows(Array.isArray(data?.reports) ? data.reports : []);
    } catch (e: any) {
      notify("Could not load reports", e?.message ?? "Please try again.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (summary.trim().length < 10) {
      notify("Summary too short", "Write at least a sentence summarizing your shift.");
      return;
    }
    if (!signature.trim()) {
      notify("Signature required", "Type your full name to sign off.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("/me/dar", {
        method: "POST",
        body: JSON.stringify({
          summary: summary.trim(),
          observations: observations.trim() || null,
          visitorsCount: Number(visitors) || 0,
          patrolsCount: Number(patrols) || 0,
          incidentsNoted: incidents.trim() || null,
          weather: weather.trim() || null,
          signature: signature.trim(),
        }),
      });
      notify("Submitted", "Your daily activity report has been filed.");
      setSummary(""); setObservations(""); setVisitors("0"); setPatrols("0");
      setIncidents(""); setWeather("");
      // Keep signature pre-filled for next submission.
      await load();
    } catch (e: any) {
      notify("Submit failed", e?.message ?? "Could not file report.");
    } finally {
      setSubmitting(false);
    }
  };

  const fieldStyle = [styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ padding: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]} accessibilityRole="header">Daily Activity Report</Text>
        <View style={{ width: 30 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.accent} />}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.helper, { color: colors.mutedForeground }]}>
              File this at the end of your shift. Site and shift are auto-attached from your most recent clock-in.
            </Text>

            <Label color={colors.foreground}>Summary *</Label>
            <TextInput
              value={summary} onChangeText={setSummary}
              multiline numberOfLines={4}
              placeholder="What happened during your shift?"
              placeholderTextColor={colors.mutedForeground}
              style={[fieldStyle, { minHeight: 100, textAlignVertical: "top" }]}
              accessibilityLabel="Summary, required"
              accessibilityHint="Write at least a sentence summarizing your shift"
            />

            <Label color={colors.foreground}>Observations</Label>
            <TextInput
              value={observations} onChangeText={setObservations}
              multiline numberOfLines={3}
              placeholder="Anything notable — equipment, hazards, behavior…"
              placeholderTextColor={colors.mutedForeground}
              style={[fieldStyle, { minHeight: 70, textAlignVertical: "top" }]}
              accessibilityLabel="Observations, optional"
            />

            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Label color={colors.foreground}>Visitors</Label>
                <TextInput value={visitors} onChangeText={setVisitors} keyboardType="number-pad" style={fieldStyle} accessibilityLabel="Number of visitors" />
              </View>
              <View style={{ flex: 1 }}>
                <Label color={colors.foreground}>Patrols</Label>
                <TextInput value={patrols} onChangeText={setPatrols} keyboardType="number-pad" style={fieldStyle} accessibilityLabel="Number of patrols" />
              </View>
            </View>

            <Label color={colors.foreground}>Incidents noted</Label>
            <TextInput
              value={incidents} onChangeText={setIncidents}
              multiline
              placeholder="Brief note (file separate Incident reports as needed)"
              placeholderTextColor={colors.mutedForeground}
              style={[fieldStyle, { minHeight: 60, textAlignVertical: "top" }]}
              accessibilityLabel="Incidents noted, optional"
            />

            <Label color={colors.foreground}>Weather</Label>
            <TextInput
              value={weather} onChangeText={setWeather}
              placeholder="Clear / Rain / Storm…"
              placeholderTextColor={colors.mutedForeground}
              style={fieldStyle}
              accessibilityLabel="Weather, optional"
            />

            <Label color={colors.foreground}>Signature (type your name) *</Label>
            <TextInput
              value={signature} onChangeText={setSignature}
              placeholder="First Last"
              placeholderTextColor={colors.mutedForeground}
              style={fieldStyle}
              accessibilityLabel="Signature, required"
              accessibilityHint="Type your full name to sign off"
            />

            <TouchableOpacity
              onPress={submit}
              disabled={submitting}
              style={[styles.submitBtn, { backgroundColor: colors.accent, opacity: submitting ? 0.6 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel="Submit report"
              accessibilityState={{ disabled: submitting, busy: submitting }}
            >
              {submitting
                ? <ActivityIndicator color={colors.primary} />
                : <Text style={{ color: colors.primary, fontWeight: "700" }}>Submit report</Text>}
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionHeader, { color: colors.foreground }]} accessibilityRole="header">My recent reports</Text>
          {rows === null ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />
          ) : rows.length === 0 ? (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>No reports filed yet.</Text>
            </View>
          ) : (
            rows.map((r) => (
              <View key={r.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, paddingVertical: 10 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{r.siteName ?? "—"}</Text>
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{fmt(r.submittedAt)}</Text>
                </View>
                <Text numberOfLines={2} style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 4 }}>
                  {r.summary}
                </Text>
                <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4 }}>
                  Visitors {r.visitorsCount} · Patrols {r.patrolsCount}
                </Text>
              </View>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Label({ children, color }: { children: React.ReactNode; color: string }) {
  return <Text style={{ color, fontSize: 12, fontWeight: "600", marginTop: 12, marginBottom: 4 }}>{children}</Text>;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 16, fontWeight: "700" },
  helper: { fontSize: 12, lineHeight: 16 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 12 },
  input: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 12 : 8, fontSize: 14,
  },
  submitBtn: { height: 46, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 18 },
  sectionHeader: { fontSize: 15, fontWeight: "700", marginTop: 24, marginBottom: 4 },
});
