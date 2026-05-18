import React, { useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Platform, Modal, TextInput, ScrollView, Image, AccessibilityInfo, findNodeHandle } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetIncidents, getGetIncidentsQueryKey, useCreateIncident } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { pickAndUploadImage, type UploadedFile } from "@/utils/upload";
import { confirmAction, notify } from "@/utils/confirm";
import { AttachmentImage } from "@/components/AttachmentImage";

const SEVERITY_LEVELS = ["low", "medium", "high", "critical"] as const;
const SEVERITY_COLORS: Record<string, string> = { low: "#22c55e", medium: "#f59e0b", high: "#f97316", critical: "#ef4444" };

export default function EmployeeIncidentsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showReport, setShowReport] = useState(false);
  const topPad = useTopPad();

  const [form, setForm] = useState({ title: "", description: "", severity: "medium" as string, location: "", actionsTaken: "" });
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [invalid, setInvalid] = useState<{ title: boolean; description: boolean }>({ title: false, description: false });
  const titleRef = React.useRef<TextInput>(null);
  const descRef = React.useRef<TextInput>(null);
  const [photos, setPhotos] = useState<UploadedFile[]>([]);
  const [pickingSource, setPickingSource] = useState<"camera" | "library" | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const addPhoto = async (source: "camera" | "library") => {
    if (pickingSource) return;
    setPickingSource(source);
    try {
      const file = await pickAndUploadImage({ source });
      if (file) setPhotos((p) => [...p, file]);
    } catch (e: any) {
      notify("Photo upload failed", e?.message || "Please try again.");
    } finally {
      setPickingSource(null);
    }
  };

  const removePhoto = (idx: number) => setPhotos((p) => p.filter((_, i) => i !== idx));

  const { data: incidents, isLoading, error, refetch } = useGetIncidents(
    {},
    { query: { queryKey: getGetIncidentsQueryKey({}) } },
  );

  const createMutation = useCreateIncident();

  const closeReport = () => {
    setShowReport(false);
    setForm({ title: "", description: "", severity: "medium", location: "", actionsTaken: "" });
    setPhotos([]);
    setInvalid({ title: false, description: false });
  };

  const handleReport = async () => {
    const nextInvalid = { title: !form.title, description: !form.description };
    if (nextInvalid.title || nextInvalid.description) {
      setInvalid(nextInvalid);
      const missing = [nextInvalid.title && "title", nextInvalid.description && "description"]
        .filter(Boolean).join(" and ");
      AccessibilityInfo.announceForAccessibility(`Cannot submit. Missing required ${missing}.`);
      const focusTarget = nextInvalid.title ? titleRef.current : descRef.current;
      if (focusTarget) {
        const node = findNodeHandle(focusTarget);
        if (node != null) { try { AccessibilityInfo.setAccessibilityFocus?.(node); } catch { /* best effort */ } }
        try { focusTarget.focus?.(); } catch { /* best effort */ }
      }
      notify("Missing Fields", "Title and description are required.");
      return;
    }
    setInvalid({ title: false, description: false });
    try {
      await createMutation.mutateAsync({
        data: {
          title: form.title, description: form.description,
          severity: form.severity as any,
          locationDescription: form.location || undefined,
          actionsTaken: form.actionsTaken || undefined,
          occurredAt: new Date().toISOString(),
          attachments: photos.map((p) => p.objectPath),
        } as any
      });
      queryClient.invalidateQueries({ queryKey: getGetIncidentsQueryKey({}) });
      closeReport();
      notify("Reported", "Your incident report has been submitted.");
    } catch (e: any) {
      notify("Error", e?.message || "Failed to submit report");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">My Incidents</Text>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.destructive }]}
          onPress={() => setShowReport(true)}
          accessibilityRole="button"
          accessibilityLabel="Report a new incident"
        >
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
            const cardA11y = `${String(item.severity).toUpperCase()} severity, status ${String(item.status).replace("_", " ")}. ${item.title}. Occurred ${new Date(item.occurredAt).toLocaleString()}.`;
            return (
              <View
                style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: c, borderLeftWidth: 3 }]}
                accessible
                accessibilityLabel={cardA11y}
              >
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
                {Array.isArray((item as any).attachments) && (item as any).attachments.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
                    {((item as any).attachments as string[]).map((p) => (
                      <AttachmentImage key={p} path={p} size={64} scope="me" onPress={(u) => setPreviewUri(u)} />
                    ))}
                  </ScrollView>
                )}
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
        <Modal transparent animationType="slide" onRequestClose={closeReport}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.foreground }]} accessibilityRole="header">Report Incident</Text>
                <TouchableOpacity onPress={closeReport} accessibilityRole="button" accessibilityLabel="Close report form"><Feather name="x" size={20} color={colors.mutedForeground} /></TouchableOpacity>
              </View>
              <KeyboardAwareScrollViewCompat style={{ maxHeight: 460 }}>
                {[
                  { label: "Title", key: "title", placeholder: "Brief description of incident", required: true },
                  { label: "Location", key: "location", placeholder: "Where did this occur?", required: false },
                ].map(({ label, key, placeholder, required }) => {
                  const fieldKey = key as "title" | "location";
                  const isInvalid = required && fieldKey === "title" && invalid.title;
                  const a11yLabel = required
                    ? `${label}, required${isInvalid ? `, invalid, ${label} is required` : ""}`
                    : label;
                  return (
                    <View key={key} style={{ marginBottom: 14 }}>
                      <Text style={[styles.fieldLabel, { color: isInvalid ? colors.destructive : colors.mutedForeground }]}>
                        {label}{required ? " *" : ""}
                      </Text>
                      <TextInput
                        ref={fieldKey === "title" ? titleRef : undefined}
                        style={[styles.fieldInput, { color: colors.foreground, borderColor: isInvalid ? colors.destructive : colors.border, backgroundColor: colors.secondary }]}
                        value={form[fieldKey]}
                        onChangeText={(v) => {
                          set(key)(v);
                          if (isInvalid && v) setInvalid((i) => ({ ...i, title: false }));
                        }}
                        placeholder={placeholder}
                        placeholderTextColor={colors.mutedForeground}
                        accessibilityLabel={a11yLabel}
                        accessibilityHint={placeholder}
                      />
                      {isInvalid && (
                        <Text accessibilityLiveRegion="polite" style={{ color: colors.destructive, fontSize: 11, marginTop: 4 }}>
                          {label} is required.
                        </Text>
                      )}
                    </View>
                  );
                })}

                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]} accessibilityRole="header">Severity, required</Text>
                <View style={styles.severityRow} accessibilityRole="radiogroup">
                  {SEVERITY_LEVELS.map((s) => {
                    const selected = form.severity === s;
                    return (
                      <TouchableOpacity
                        key={s}
                        style={[styles.sevChip, { borderColor: selected ? SEVERITY_COLORS[s] : colors.border, backgroundColor: selected ? SEVERITY_COLORS[s] + "20" : "transparent" }]}
                        onPress={() => set("severity")(s)}
                        accessibilityRole="radio"
                        accessibilityLabel={`Severity ${s}`}
                        accessibilityState={{ selected, checked: selected }}
                      >
                        <Text style={[styles.sevText, { color: selected ? SEVERITY_COLORS[s] : colors.mutedForeground }]}>{s.toUpperCase()}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={[styles.fieldLabel, { color: invalid.description ? colors.destructive : colors.mutedForeground, marginTop: 14 }]}>Description *</Text>
                <TextInput
                  ref={descRef}
                  style={[styles.fieldInput, styles.multilineInput, { color: colors.foreground, borderColor: invalid.description ? colors.destructive : colors.border, backgroundColor: colors.secondary }]}
                  value={form.description}
                  onChangeText={(v) => {
                    set("description")(v);
                    if (invalid.description && v) setInvalid((i) => ({ ...i, description: false }));
                  }}
                  placeholder="Provide full details of what happened..."
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  accessibilityLabel={`Description, required${invalid.description ? ", invalid, description is required" : ""}`}
                  accessibilityHint="Provide full details of what happened"
                />
                {invalid.description && (
                  <Text accessibilityLiveRegion="polite" style={{ color: colors.destructive, fontSize: 11, marginTop: 4 }}>
                    Description is required.
                  </Text>
                )}

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
                  accessibilityLabel="Actions taken"
                  accessibilityHint="Optional. What steps did you take immediately?"
                />

                <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 14 }]}>
                  Photos {photos.length > 0 ? `(${photos.length})` : ""}
                </Text>
                <View style={styles.photoBtnRow}>
                  <TouchableOpacity
                    style={[styles.photoBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "15", opacity: pickingSource ? 0.6 : 1 }]}
                    onPress={() => addPhoto("camera")}
                    disabled={!!pickingSource}
                    accessibilityRole="button"
                    accessibilityLabel="Take photo with camera"
                    accessibilityState={{ disabled: !!pickingSource, busy: pickingSource === "camera" }}
                  >
                    {pickingSource === "camera"
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Feather name="camera" size={16} color={colors.primary} />}
                    <Text style={[styles.photoBtnText, { color: colors.primary }]}>Take Photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.photoBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "15", opacity: pickingSource ? 0.6 : 1 }]}
                    onPress={() => addPhoto("library")}
                    disabled={!!pickingSource}
                    accessibilityRole="button"
                    accessibilityLabel="Add photo from library"
                    accessibilityState={{ disabled: !!pickingSource, busy: pickingSource === "library" }}
                  >
                    {pickingSource === "library"
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Feather name="image" size={16} color={colors.primary} />}
                    <Text style={[styles.photoBtnText, { color: colors.primary }]}>From Library</Text>
                  </TouchableOpacity>
                </View>
                {photos.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
                    {photos.map((p, idx) => (
                      <View key={p.objectPath} style={styles.thumbWrap} accessibilityLabel={`Attached photo ${idx + 1} of ${photos.length}`}>
                        <Image source={{ uri: p.localUri }} style={styles.thumbImg} resizeMode="cover" accessibilityIgnoresInvertColors />
                        <TouchableOpacity
                          style={[styles.removeBtn, { backgroundColor: colors.destructive }]}
                          onPress={async () => {
                            const ok = await confirmAction({ title: "Remove photo?", confirmText: "Remove", destructive: true });
                            if (ok) removePhoto(idx);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove photo ${idx + 1}`}
                        >
                          <Feather name="x" size={12} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )}
              </KeyboardAwareScrollViewCompat>
              <TouchableOpacity
                style={[styles.submitBtn, { backgroundColor: colors.destructive, opacity: createMutation.isPending ? 0.7 : 1 }]}
                onPress={handleReport}
                disabled={createMutation.isPending}
                accessibilityRole="button"
                accessibilityLabel="Submit incident report"
                accessibilityState={{ disabled: createMutation.isPending, busy: createMutation.isPending }}
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

      {previewUri && (
        <Modal transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
          <TouchableOpacity style={styles.previewOverlay} activeOpacity={1} onPress={() => setPreviewUri(null)}>
            <Image source={{ uri: previewUri }} style={styles.previewImg} resizeMode="contain" />
            <View style={styles.previewClose}>
              <Feather name="x" size={28} color="#fff" />
            </View>
          </TouchableOpacity>
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
  photoBtnRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  photoBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  photoBtnText: { fontSize: 13, fontWeight: "600" },
  thumbRow: { gap: 8, paddingTop: 10, paddingRight: 4 },
  thumbWrap: { position: "relative" },
  thumbImg: { width: 64, height: 64, borderRadius: 6 },
  removeBtn: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  previewOverlay: { flex: 1, backgroundColor: "#000000ee", alignItems: "center", justifyContent: "center" },
  previewImg: { width: "100%", height: "85%" },
  previewClose: { position: "absolute", top: 40, right: 20, padding: 8 },
});
