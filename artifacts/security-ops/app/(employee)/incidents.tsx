import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform, Modal, TextInput } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetIncidents, getGetIncidentsQueryKey, useCreateIncident } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";

const SEVERITY_LEVELS = ["low", "medium", "high", "critical"] as const;
const SEVERITY_COLORS: Record<string, string> = { low: "#22c55e", medium: "#f59e0b", high: "#f97316", critical: "#ef4444" };

export default function EmployeeIncidentsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showReport, setShowReport] = useState(false);
  const topPad = Platform.OS === "web" ? 67 : 0;

  const [form, setForm] = useState({ title: "", description: "", severity: "medium" as string, location: "", actionsTaken: "" });
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const { data: incidents, isLoading, error, refetch } = useGetIncidents(
    {},
    { query: { queryKey: getGetIncidentsQueryKey({}) } },
  );

  const createMutation = useCreateIncident();

  const handleReport = async () => {
    if (!form.title || !form.description) {
      Alert.alert("Missing Fields", "Title and description are required.");
      return;
    }
    try {
      await createMutation.mutateAsync({
        data: {
          title: form.title, description: form.description,
          severity: form.severity as any,
          locationDescription: form.location || undefined,
          actionsTaken: form.actionsTaken || undefined,
          occurredAt: new Date().toISOString(),
        } as any
      });
      queryClient.invalidateQueries({ queryKey: getGetIncidentsQueryKey({}) });
      setShowReport(false);
      setForm({ title: "", description: "", severity: "medium", location: "", actionsTaken: "" });
      Alert.alert("Reported", "Your incident report has been submitted.");
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to submit report");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>My Incidents</Text>
        <TouchableOpacity style={[styles.addBtn, { backgroundColor: colors.destructive }]} onPress={() => setShowReport(true)}>
          <Feather name="plus" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive, marginBottom: 12 }}>Failed to load incidents</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { borderColor: colors.primary }]}><Text style={{ color: colors.primary }}>Retry</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={incidents ?? []}
          keyExtractor={(item) => item.id}
          scrollEnabled={!!(incidents && incidents.length > 0)}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={[styles.emptyIcon, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="shield" size={40} color={colors.primary} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No incidents reported</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Tap the + button to report an incident</Text>
              <TouchableOpacity style={[styles.reportBigBtn, { backgroundColor: colors.destructive }]} onPress={() => setShowReport(true)}>
                <Feather name="alert-triangle" size={18} color="#fff" />
                <Text style={styles.reportBigBtnText}>Report Incident</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }) => {
            const c = SEVERITY_COLORS[item.severity] || colors.mutedForeground;
            const statusMap: Record<string, string> = { open: colors.destructive, under_review: colors.accent, resolved: colors.primary, closed: colors.mutedForeground };
            const sc = statusMap[item.status] || colors.mutedForeground;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: c, borderLeftWidth: 3 }]}>
                <View style={styles.cardHeader}>
                  <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
                    <Text style={[styles.badgeText, { color: c }]}>{item.severity.toUpperCase()}</Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: sc + "20", borderColor: sc }]}>
                    <Text style={[styles.badgeText, { color: sc }]}>{item.status.replace("_", " ").toUpperCase()}</Text>
                  </View>
                </View>
                <Text style={[styles.incTitle, { color: colors.foreground }]}>{item.title}</Text>
                <Text style={[styles.incDesc, { color: colors.mutedForeground }]} numberOfLines={2}>{item.description}</Text>
                {(item as any).locationDescription && (
                  <View style={styles.metaRow}>
                    <Feather name="map-pin" size={12} color={colors.mutedForeground} />
                    <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{(item as any).locationDescription}</Text>
                  </View>
                )}
                <View style={styles.metaRow}>
                  <Feather name="calendar" size={12} color={colors.mutedForeground} />
                  <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{new Date(item.occurredAt).toLocaleString()}</Text>
                </View>
                {(item as any).adminNotes && (
                  <View style={[styles.resolutionBox, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "30" }]}>
                    <Text style={[styles.resLabel, { color: colors.primary }]}>RESOLUTION</Text>
                    <Text style={[styles.resText, { color: colors.foreground }]}>{(item as any).adminNotes}</Text>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {showReport && (
        <Modal transparent animationType="slide" onRequestClose={() => setShowReport(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Report Incident</Text>
                <TouchableOpacity onPress={() => setShowReport(false)}><Feather name="x" size={20} color={colors.mutedForeground} /></TouchableOpacity>
              </View>
              <KeyboardAwareScrollViewCompat style={{ maxHeight: 460 }}>
                {[
                  { label: "Title *", key: "title", placeholder: "Brief description of incident" },
                  { label: "Location", key: "location", placeholder: "Where did this occur?" },
                ].map(({ label, key, placeholder }) => (
                  <View key={key} style={{ marginBottom: 14 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
                    <TextInput
                      style={[styles.fieldInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                      value={(form as any)[key]}
                      onChangeText={set(key)}
                      placeholder={placeholder}
                      placeholderTextColor={colors.mutedForeground}
                    />
                  </View>
                ))}

                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Severity *</Text>
                <View style={styles.severityRow}>
                  {SEVERITY_LEVELS.map((s) => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.sevChip, { borderColor: form.severity === s ? SEVERITY_COLORS[s] : colors.border, backgroundColor: form.severity === s ? SEVERITY_COLORS[s] + "20" : "transparent" }]}
                      onPress={() => set("severity")(s)}
                    >
                      <Text style={[styles.sevText, { color: form.severity === s ? SEVERITY_COLORS[s] : colors.mutedForeground }]}>{s.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 14 }]}>Description *</Text>
                <TextInput
                  style={[styles.fieldInput, styles.multilineInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                  value={form.description}
                  onChangeText={set("description")}
                  placeholder="Provide full details of what happened..."
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />

                <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 14 }]}>Actions Taken</Text>
                <TextInput
                  style={[styles.fieldInput, styles.multilineInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                  value={form.actionsTaken}
                  onChangeText={set("actionsTaken")}
                  placeholder="What steps did you take immediately?"
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
              </KeyboardAwareScrollViewCompat>
              <TouchableOpacity
                style={[styles.submitBtn, { backgroundColor: colors.destructive, opacity: createMutation.isPending ? 0.7 : 1 }]}
                onPress={handleReport}
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Feather name="alert-triangle" size={18} color="#fff" />
                    <Text style={styles.submitText}>Submit Report</Text>
                  </>
                )}
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
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  addBtn: { width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardHeader: { flexDirection: "row", gap: 8 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  incTitle: { fontSize: 15, fontWeight: "700" },
  incDesc: { fontSize: 13, lineHeight: 18 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { fontSize: 12 },
  resolutionBox: { borderRadius: 6, borderWidth: 1, padding: 10, gap: 3 },
  resLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1.5 },
  resText: { fontSize: 13 },
  emptyState: { alignItems: "center", paddingTop: 60, gap: 12 },
  emptyIcon: { width: 80, height: 80, borderRadius: 40, justifyContent: "center", alignItems: "center", borderWidth: 1 },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyText: { fontSize: 14 },
  reportBigBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, marginTop: 8 },
  reportBigBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  modalOverlay: { flex: 1, backgroundColor: "#000000bb", justifyContent: "flex-end" },
  modalCard: { borderRadius: 20, borderWidth: 1, padding: 20, gap: 14, margin: 12 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  fieldLabel: { fontSize: 12, marginBottom: 6, fontWeight: "500" },
  fieldInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  multilineInput: { minHeight: 80, paddingTop: 10 },
  severityRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  sevChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  sevText: { fontSize: 11, fontWeight: "700" },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 10 },
  submitText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
