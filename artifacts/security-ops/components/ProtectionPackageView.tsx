import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Linking, ScrollView, Modal, Image, Pressable,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import {
  useGetProtectionDetail, getGetProtectionDetailQueryKey,
  type ProtectionDetail, type ProtectionPerson, type ProtectionDestination,
} from "@workspace/api-client-react";
import { AttachmentImage } from "@/components/AttachmentImage";
import { formatDateTime } from "@/utils/time";

/**
 * Read-only mobile view of a shift's executive-protection ("PPO Detail")
 * package. Rendered only when the shift is a PPO detail; the GET endpoint
 * itself enforces who may read it (admin OR an officer with an ACCEPTED
 * assignment — no other role). On 403/other errors we render nothing so the
 * brief stays invisible to anyone not authorized.
 *
 * Photos resolve through /me/storage/sign (scope="me"), which the server
 * authorizes for every caller allowed to read the package — so one scope works
 * for admins and assigned officers alike. This data is highly sensitive PII and never
 * appears on public/share surfaces.
 */

const THREAT_COLORS: Record<string, string> = {
  low: "#22c55e",
  guarded: "#3b82f6",
  elevated: "#f59e0b",
  high: "#f97316",
  severe: "#ef4444",
};

function openInMaps(d: ProtectionDestination) {
  const query =
    d.lat != null && d.lng != null
      ? `${d.lat},${d.lng}`
      : (d.address ?? d.label ?? "").trim();
  if (!query) return;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  Linking.openURL(url).catch(() => {});
}

function hasPreplan(p: ProtectionDetail): boolean {
  return Boolean(
    p.threatLevel || p.missionSummary || p.dressCode || p.armamentInstructions ||
    p.communicationPlan || p.medicalNotes || p.emergencyRendezvous ||
    p.vehicleDetails || p.specialInstructions,
  );
}

export function ProtectionPackageView({ shiftId }: { shiftId: string }) {
  const colors = useColors();
  const [lightbox, setLightbox] = useState<string | null>(null);

  const { data, isLoading, isError } = useGetProtectionDetail(shiftId, {
    query: {
      queryKey: getGetProtectionDetailQueryKey(shiftId),
      enabled: !!shiftId,
      retry: false,
    },
  });

  if (isLoading) {
    return (
      <View style={[styles.section, styles.center, { backgroundColor: colors.card, borderColor: colors.accent }]}>
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }
  // 403 / network error → render nothing (never hint at restricted content).
  if (isError || !data) return null;

  const pkg = data;
  const empty =
    !hasPreplan(pkg) &&
    (pkg.principals?.length ?? 0) === 0 &&
    (pkg.threats?.length ?? 0) === 0 &&
    (pkg.destinations?.length ?? 0) === 0;

  const threatKey = (pkg.threatLevel ?? "").toLowerCase();
  const threatColor = THREAT_COLORS[threatKey] ?? colors.mutedForeground;

  const renderPreplanField = (label: string, value?: string | null) => {
    if (!value) return null;
    return (
      <View key={label} style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.fieldValue, { color: colors.foreground }]}>{value}</Text>
      </View>
    );
  };

  const renderPerson = (person: ProtectionPerson, idx: number, kind: "principal" | "threat") => {
    const isThreat = kind === "threat";
    const demo: [string, string | null | undefined][] = [
      ["Sex", person.sex],
      ["Age", person.age],
      ["Height", person.height],
      ["Weight", person.weight],
      ["Hair", person.hairColor],
      ["Eyes", person.eyeColor],
    ];
    const demoShown = demo.filter(([, v]) => !!v);
    return (
      <View
        key={person.id}
        style={[
          styles.personCard,
          { borderColor: isThreat ? colors.destructive + "55" : colors.accent + "55", backgroundColor: colors.background },
        ]}
      >
        <View style={styles.personHead}>
          <Feather name={isThreat ? "alert-triangle" : "user"} size={14} color={isThreat ? colors.destructive : colors.accent} />
          <Text style={[styles.personName, { color: colors.foreground }]}>
            {person.name || `${isThreat ? "Threat" : "Principal"} ${idx + 1}`}
          </Text>
        </View>
        {!!person.relationship && (
          <Text style={[styles.personRel, { color: colors.mutedForeground }]}>{person.relationship}</Text>
        )}

        {person.photoKeys.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow} contentContainerStyle={{ gap: 8 }}>
            {person.photoKeys.map((key) => (
              <AttachmentImage
                key={key}
                path={key}
                size={84}
                scope="me"
                onPress={(signed) => setLightbox(signed)}
              />
            ))}
          </ScrollView>
        )}

        {demoShown.length > 0 && (
          <View style={styles.demoGrid}>
            {demoShown.map(([k, v]) => (
              <View key={k} style={styles.demoItem}>
                <Text style={[styles.demoLabel, { color: colors.mutedForeground }]}>{k}</Text>
                <Text style={[styles.demoValue, { color: colors.foreground }]}>{v}</Text>
              </View>
            ))}
          </View>
        )}

        {!!person.distinguishingFeatures && (
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Distinguishing features</Text>
            <Text style={[styles.fieldValue, { color: colors.foreground }]}>{person.distinguishingFeatures}</Text>
          </View>
        )}
        {!!person.notes && (
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Notes</Text>
            <Text style={[styles.fieldValue, { color: colors.foreground }]}>{person.notes}</Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.accent }]}>
      <View style={styles.titleRow}>
        <Feather name="shield" size={14} color={colors.accent} />
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>PROTECTION DETAIL</Text>
        {!!pkg.threatLevel && (
          <View style={[styles.threatBadge, { backgroundColor: threatColor + "22", borderColor: threatColor }]}>
            <Text style={[styles.threatText, { color: threatColor }]}>{pkg.threatLevel.toUpperCase()}</Text>
          </View>
        )}
      </View>

      {empty ? (
        <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
          No protection brief has been added yet.
        </Text>
      ) : (
        <>
          {hasPreplan(pkg) && (
            <View style={styles.block}>
              {renderPreplanField("Mission summary", pkg.missionSummary)}
              {renderPreplanField("Communication plan", pkg.communicationPlan)}
              {renderPreplanField("Dress code", pkg.dressCode)}
              {renderPreplanField("Armament instructions", pkg.armamentInstructions)}
              {renderPreplanField("Vehicle details", pkg.vehicleDetails)}
              {renderPreplanField("Emergency rendezvous", pkg.emergencyRendezvous)}
              {renderPreplanField("Medical notes", pkg.medicalNotes)}
              {renderPreplanField("Special instructions", pkg.specialInstructions)}
            </View>
          )}

          {(pkg.principals?.length ?? 0) > 0 && (
            <View style={styles.block}>
              <Text style={[styles.groupLabel, { color: colors.foreground }]}>
                Principals ({pkg.principals.length})
              </Text>
              {pkg.principals.map((p, i) => renderPerson(p, i, "principal"))}
            </View>
          )}

          {(pkg.threats?.length ?? 0) > 0 && (
            <View style={styles.block}>
              <Text style={[styles.groupLabel, { color: colors.foreground }]}>
                Threats / persons of interest ({pkg.threats.length})
              </Text>
              {pkg.threats.map((p, i) => renderPerson(p, i, "threat"))}
            </View>
          )}

          {(pkg.destinations?.length ?? 0) > 0 && (
            <View style={styles.block}>
              <Text style={[styles.groupLabel, { color: colors.foreground }]}>
                Destinations ({pkg.destinations.length})
              </Text>
              {pkg.destinations.map((d, i) => {
                const subtitle = [
                  d.address,
                  d.arrivalTime ? `Arrive ${formatDateTime(d.arrivalTime)}` : null,
                  d.departureTime ? `Depart ${formatDateTime(d.departureTime)}` : null,
                ].filter(Boolean).join(" · ");
                const canMap = (d.lat != null && d.lng != null) || !!(d.address || d.label);
                return (
                  <View key={d.id} style={[styles.destRow, { borderColor: colors.border }]}>
                    <View style={[styles.destNum, { backgroundColor: colors.primary }]}>
                      <Text style={styles.destNumText}>{i + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.destLabel, { color: colors.foreground }]}>
                        {d.label || d.address || `Stop ${i + 1}`}
                      </Text>
                      {!!subtitle && (
                        <Text style={[styles.destSub, { color: colors.mutedForeground }]}>{subtitle}</Text>
                      )}
                      {!!d.notes && (
                        <Text style={[styles.destSub, { color: colors.mutedForeground }]}>{d.notes}</Text>
                      )}
                    </View>
                    {canMap && (
                      <TouchableOpacity
                        onPress={() => openInMaps(d)}
                        style={[styles.mapBtn, { borderColor: colors.primary }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${d.label || d.address || `stop ${i + 1}`} in maps`}
                      >
                        <Feather name="map-pin" size={14} color={colors.primary} />
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </>
      )}

      <Modal visible={!!lightbox} transparent animationType="fade" onRequestClose={() => setLightbox(null)}>
        <Pressable
          style={styles.lightboxBackdrop}
          onPress={() => setLightbox(null)}
          accessibilityRole="button"
          accessibilityLabel="Close photo"
        >
          {!!lightbox && <Image source={{ uri: lightbox }} style={styles.lightboxImg} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, borderWidth: 1, padding: 16 },
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 20 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2 },
  threatBadge: { marginLeft: "auto", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  threatText: { fontSize: 10, fontWeight: "700" },
  block: { marginBottom: 8 },
  groupLabel: { fontSize: 13, fontWeight: "700", marginBottom: 8 },
  field: { marginBottom: 8 },
  fieldLabel: { fontSize: 11, marginBottom: 2 },
  fieldValue: { fontSize: 14, lineHeight: 20 },
  personCard: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10, gap: 4 },
  personHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  personName: { fontSize: 14, fontWeight: "700", flex: 1 },
  personRel: { fontSize: 12 },
  photoRow: { marginVertical: 6 },
  demoGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  demoItem: { width: "33.33%", paddingVertical: 4, paddingRight: 6 },
  demoLabel: { fontSize: 10 },
  demoValue: { fontSize: 13, fontWeight: "500" },
  destRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  destNum: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  destNumText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  destLabel: { fontSize: 14, fontWeight: "500" },
  destSub: { fontSize: 12, marginTop: 2 },
  mapBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  emptyText: { fontSize: 13, fontStyle: "italic" },
  lightboxBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center", padding: 16 },
  lightboxImg: { width: "100%", height: "80%" },
});
