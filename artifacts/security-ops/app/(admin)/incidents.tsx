import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Platform, TextInput, Modal, ScrollView, Image } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetIncidents, getGetIncidentsQueryKey, useUpdateIncident } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { AttachmentImage } from "@/components/AttachmentImage";
import { useRouter } from "expo-router";

const STATUS_FILTERS = ["open", "under_review", "resolved", "closed"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

function SeverityBadge({ severity }: { severity: string }) {
  const colors = useColors();
  const map: Record<string, string> = { low: "#22c55e", medium: colors.accent, high: "#f97316", critical: colors.destructive };
  const c = map[severity] || colors.mutedForeground;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{severity.toUpperCase()}</Text>
    </View>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const map: Record<string, string> = { open: colors.destructive, under_review: colors.accent, resolved: colors.primary, closed: colors.mutedForeground };
  const c = map[status] || colors.mutedForeground;
  return (
    <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{status.replace("_", " ").toUpperCase()}</Text>
    </View>
  );
}

export default function AdminIncidentsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState<string>("open");
  const [selectedIncident, setSelectedIncident] = useState<any>(null);
  const [resolution, setResolution] = useState("");
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const topPad = Platform.OS === "web" ? 67 : 0;

  const incParams: any = { status: filter };
  const { data: incidents, isLoading, error, refetch } = useGetIncidents(
    incParams,
    { query: { queryKey: getGetIncidentsQueryKey(incParams) } },
  );

  const updateMutation = useUpdateIncident();

  const handleUpdateStatus = async (id: string, status: string) => {
    await updateMutation.mutateAsync({ id, data: { status: status as any, adminNotes: resolution || undefined, resolvedAt: status === "resolved" ? new Date().toISOString() : undefined } });
    queryClient.invalidateQueries({ queryKey: getGetIncidentsQueryKey() });
    setSelectedIncident(null);
    setResolution("");
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Incidents</Text>
        {filter === "open" && (incidents?.length ?? 0) > 0 && (
          <View style={[styles.critBadge, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
            <Text style={[styles.critText, { color: colors.destructive }]}>
              {incidents!.filter((i) => i.severity === "critical").length} CRITICAL
            </Text>
          </View>
        )}
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterChip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, { color: filter === f ? colors.primary : colors.mutedForeground }]}>
              {f.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            </Text>
          </TouchableOpacity>
        ))}
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
            <View style={styles.center}>
              <Feather name="shield" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No {filter.replace("_", " ")} incidents</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: colors.card, borderColor: item.severity === "critical" ? colors.destructive + "60" : colors.border }]}
              onPress={() => { setSelectedIncident(item); setResolution((item as any).adminNotes || ""); }}
            >
              <View style={styles.cardHeader}>
                <SeverityBadge severity={item.severity} />
                <StatusBadge status={item.status} />
              </View>
              <Text style={[styles.incidentTitle, { color: colors.foreground }]}>{item.title}</Text>
              <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={2}>{item.description}</Text>
              <View style={styles.metaRow}>
                <Feather name="user" size={13} color={colors.mutedForeground} />
                <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{item.employeeName}</Text>
                <Feather name="calendar" size={13} color={colors.mutedForeground} style={{ marginLeft: 8 }} />
                <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{new Date(item.occurredAt).toLocaleDateString()}</Text>
              </View>
              {(item as any).locationDescription && (
                <View style={styles.metaRow}>
                  <Feather name="map-pin" size={13} color={colors.mutedForeground} />
                  <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{(item as any).locationDescription}</Text>
                </View>
              )}
              {Array.isArray((item as any).attachments) && (item as any).attachments.length > 0 && (
                <View style={styles.attachmentTag}>
                  <Feather name="paperclip" size={12} color={colors.mutedForeground} />
                  <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                    {(item as any).attachments.length} photo{(item as any).attachments.length === 1 ? "" : "s"}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        />
      )}

      {selectedIncident && (
        <Modal transparent animationType="slide" onRequestClose={() => setSelectedIncident(null)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.foreground }]} numberOfLines={2}>{selectedIncident.title}</Text>
                <TouchableOpacity onPress={() => setSelectedIncident(null)}>
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>

              {selectedIncident.employeeId && (
                <TouchableOpacity
                  style={[styles.officerLink, { borderColor: colors.primary }]}
                  onPress={() => {
                    const eid = selectedIncident.employeeId;
                    setSelectedIncident(null);
                    router.push(`/(admin)/employees/${eid}` as any);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`View profile for ${selectedIncident.employeeName}`}
                >
                  <Feather name="user" size={14} color={colors.primary} />
                  <Text style={[styles.officerLinkText, { color: colors.primary }]} numberOfLines={1}>
                    {selectedIncident.employeeName || "View officer profile"}
                  </Text>
                  <Feather name="chevron-right" size={16} color={colors.primary} />
                </TouchableOpacity>
              )}

              <ScrollView style={{ maxHeight: 340 }}>
                <Text style={[styles.descFull, { color: colors.foreground }]}>{selectedIncident.description}</Text>
                {Array.isArray(selectedIncident.attachments) && selectedIncident.attachments.length > 0 && (
                  <View style={[styles.sectionBox, { borderColor: colors.border }]}>
                    <Text style={[styles.boxLabel, { color: colors.primary }]}>PHOTOS ({selectedIncident.attachments.length})</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
                      {(selectedIncident.attachments as string[]).map((p) => (
                        <AttachmentImage key={p} path={p} size={84} scope="admin" onPress={(u) => setPreviewUri(u)} />
                      ))}
                    </ScrollView>
                  </View>
                )}
                {selectedIncident.actionsTaken && (
                  <View style={[styles.sectionBox, { borderColor: colors.border }]}>
                    <Text style={[styles.boxLabel, { color: colors.accent }]}>ACTIONS TAKEN</Text>
                    <Text style={[styles.boxText, { color: colors.foreground }]}>{selectedIncident.actionsTaken}</Text>
                  </View>
                )}
                {selectedIncident.resolution && (
                  <View style={[styles.sectionBox, { borderColor: colors.border }]}>
                    <Text style={[styles.boxLabel, { color: colors.primary }]}>RESOLUTION</Text>
                    <Text style={[styles.boxText, { color: colors.foreground }]}>{selectedIncident.resolution}</Text>
                  </View>
                )}
              </ScrollView>

              <TextInput
                style={[styles.resolutionInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
                placeholder="Add resolution notes..."
                placeholderTextColor={colors.mutedForeground}
                value={resolution}
                onChangeText={setResolution}
                multiline
                numberOfLines={3}
              />

              <View style={styles.modalActions}>
                {selectedIncident.status === "open" && (
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.accent + "20", borderColor: colors.accent }]} onPress={() => handleUpdateStatus(selectedIncident.id, "under_review")}>
                    <Text style={[styles.modalBtnText, { color: colors.accent }]}>Under Review</Text>
                  </TouchableOpacity>
                )}
                {(selectedIncident.status === "open" || selectedIncident.status === "under_review") && (
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.primary + "20", borderColor: colors.primary }]} onPress={() => handleUpdateStatus(selectedIncident.id, "resolved")}>
                    <Text style={[styles.modalBtnText, { color: colors.primary }]}>Resolve</Text>
                  </TouchableOpacity>
                )}
                {selectedIncident.status === "resolved" && (
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.mutedForeground + "20", borderColor: colors.mutedForeground }]} onPress={() => handleUpdateStatus(selectedIncident.id, "closed")}>
                    <Text style={[styles.modalBtnText, { color: colors.mutedForeground }]}>Close</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </Modal>
      )}

      {previewUri && (
        <Modal transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
          <TouchableOpacity style={styles.previewOverlay} activeOpacity={1} onPress={() => setPreviewUri(null)}>
            <Image source={{ uri: previewUri }} style={styles.previewImg} resizeMode="contain" />
            <View style={styles.previewClose}><Feather name="x" size={28} color="#fff" /></View>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  critBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  critText: { fontSize: 11, fontWeight: "700" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10, flexWrap: "wrap" },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  filterText: { fontSize: 12, fontWeight: "600" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardHeader: { flexDirection: "row", gap: 8 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  incidentTitle: { fontSize: 15, fontWeight: "700" },
  description: { fontSize: 13, lineHeight: 18 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  metaText: { fontSize: 12 },
  emptyText: { marginTop: 12, fontSize: 15 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  modalOverlay: { flex: 1, backgroundColor: "#000000aa", justifyContent: "flex-end" },
  modalCard: { borderRadius: 20, borderWidth: 1, padding: 20, gap: 14, margin: 12 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  modalTitle: { fontSize: 17, fontWeight: "700", flex: 1 },
  descFull: { fontSize: 14, lineHeight: 20, marginBottom: 10 },
  sectionBox: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10 },
  boxLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1.5, marginBottom: 4 },
  boxText: { fontSize: 13 },
  resolutionInput: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 14, minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", gap: 10 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  modalBtnText: { fontWeight: "700", fontSize: 14 },
  attachmentTag: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  officerLink: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  officerLinkText: { flex: 1, fontSize: 13, fontWeight: "600" },
  thumbRow: { gap: 8, paddingVertical: 4 },
  previewOverlay: { flex: 1, backgroundColor: "#000000ee", alignItems: "center", justifyContent: "center" },
  previewImg: { width: "100%", height: "85%" },
  previewClose: { position: "absolute", top: 40, right: 20, padding: 8 },
});
