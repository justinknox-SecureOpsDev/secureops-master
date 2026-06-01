import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, Image, Platform, RefreshControl,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { notify } from "@/utils/confirm";
import { pickAndUploadImage, type UploadedFile } from "@/utils/upload";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

type License = {
  id: string;
  type: string;
  level: number | null;
  licenseNumber: string;
  expiryDate: string;
  status: "valid" | "expiring_soon" | "expired";
};

type Renewal = {
  id: string;
  licenseId: string | null;
  licenseType: string;
  licenseLevel: number | null;
  licenseNumber: string;
  expiryDate: string;
  status: "pending" | "approved" | "rejected";
  decisionNote: string | null;
  createdAt: string;
};

const LEVEL_OPTIONS = [
  { value: 2, label: "L2 (unarmed)" },
  { value: 3, label: "L3 (armed)" },
  { value: 4, label: "L4 (PPO)" },
];

const STATUS_COLOR: Record<Renewal["status"], string> = {
  pending: "#f59e0b",
  approved: "#22c55e",
  rejected: "#ef4444",
};

export default function LicenseRenewalScreen() {
  const colors = useColors();
  const topPad = useTopPad();
  const router = useRouter();

  const [licenses, setLicenses] = useState<License[] | null>(null);
  const [renewals, setRenewals] = useState<Renewal[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [renewLicenseId, setRenewLicenseId] = useState<string | "new" | null>(null);
  const [licenseType, setLicenseType] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [level, setLevel] = useState<number | null>(null);
  const [issuingAuthority, setIssuingAuthority] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [lic, ren] = await Promise.all([
        apiRequest("/licenses"),
        apiRequest("/me/license-renewals"),
      ]);
      setLicenses(Array.isArray(lic) ? lic : []);
      setRenewals(Array.isArray(ren) ? ren : []);
    } catch (e: any) {
      notify("Could not load licenses", e?.message ?? "Please try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Pre-fill the form when an existing license is picked.
  const selectLicense = (id: string | "new") => {
    setRenewLicenseId(id);
    if (id === "new") {
      setLicenseType("");
      setLicenseNumber("");
      setLevel(null);
      setIssuingAuthority("");
      setIssueDate("");
      setExpiryDate("");
    } else {
      const l = (licenses ?? []).find((x) => x.id === id);
      if (l) {
        setLicenseType(l.type);
        setLicenseNumber(l.licenseNumber);
        setLevel(l.level);
        // Officer enters the new expiry; do not prefill from old row.
        setExpiryDate("");
        setIssueDate("");
        setIssuingAuthority("");
      }
    }
  };

  const pendingForSelected = useMemo(() => {
    if (renewLicenseId == null || renewLicenseId === "new") return null;
    return (renewals ?? []).find((r) => r.licenseId === renewLicenseId && r.status === "pending") ?? null;
  }, [renewals, renewLicenseId]);

  const pickPhoto = async (source: "camera" | "library") => {
    setUploading(true);
    try {
      const f = await pickAndUploadImage({ source });
      if (f) setUploaded(f);
    } catch (e: any) {
      notify("Upload failed", e?.message ?? "Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (renewLicenseId == null) {
      notify("Pick a license", "Choose which license you are renewing.");
      return;
    }
    if (!licenseType.trim() || !licenseNumber.trim() || !expiryDate.trim()) {
      notify("Missing info", "Type, number, and new expiry date are required.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      notify("Invalid date", "Expiry date must be in YYYY-MM-DD format.");
      return;
    }
    if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
      notify("Invalid date", "Issue date must be in YYYY-MM-DD format.");
      return;
    }
    if (!uploaded) {
      notify("Photo required", "Please attach a photo of the renewed license.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest("/me/license-renewals", {
        method: "POST",
        body: JSON.stringify({
          licenseId: renewLicenseId === "new" ? null : renewLicenseId,
          licenseType: licenseType.trim(),
          licenseLevel: level,
          licenseNumber: licenseNumber.trim(),
          issuingAuthority: issuingAuthority.trim() || null,
          issueDate: issueDate.trim() || null,
          expiryDate: expiryDate.trim(),
          docKey: uploaded.objectPath,
          notes: notes.trim() || null,
        }),
      });
      notify("Submitted", "Your renewal is queued for admin review.");
      setRenewLicenseId(null);
      setLicenseType(""); setLicenseNumber(""); setLevel(null);
      setIssuingAuthority(""); setIssueDate(""); setExpiryDate("");
      setNotes(""); setUploaded(null);
      await load();
    } catch (e: any) {
      notify("Submit failed", e?.message ?? "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: topPad }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]} accessibilityRole="header">License renewals</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 60, gap: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {/* ----- History ----- */}
        {renewals && renewals.length > 0 && (
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]} accessibilityRole="header">Your submissions</Text>
            <View style={{ gap: 8, marginTop: 8 }}>
              {renewals.map((r) => {
                const sc = STATUS_COLOR[r.status];
                return (
                  <View key={r.id} style={[styles.histCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <View style={styles.histHead}>
                      <Text style={[styles.histType, { color: colors.foreground }]}>
                        {r.licenseType}{r.licenseLevel != null ? ` · L${r.licenseLevel}` : ""}
                      </Text>
                      <View style={[styles.pill, { borderColor: sc, backgroundColor: sc + "20" }]}>
                        <Text style={[styles.pillText, { color: sc }]}>{r.status.toUpperCase()}</Text>
                      </View>
                    </View>
                    <Text style={[styles.histMeta, { color: colors.mutedForeground }]}>
                      #{r.licenseNumber} · expires {r.expiryDate}
                    </Text>
                    <Text style={[styles.histMeta, { color: colors.mutedForeground }]}>
                      Submitted {new Date(r.createdAt).toLocaleDateString()}
                    </Text>
                    {r.decisionNote && (
                      <Text style={[styles.histNote, { color: colors.foreground }]}>"{r.decisionNote}"</Text>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* ----- New submission ----- */}
        <View>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]} accessibilityRole="header">Submit a renewal</Text>
          <Text style={[styles.help, { color: colors.mutedForeground }]}>
            Pick the license you renewed (or "New license"), enter the new details, attach a photo of the renewed card, and submit for admin review.
          </Text>

          {/* Picker: existing licenses + "New license" */}
          <View style={{ marginTop: 10, gap: 8 }}>
            {(licenses ?? []).map((l) => {
              const picked = renewLicenseId === l.id;
              return (
                <TouchableOpacity
                  key={l.id}
                  onPress={() => selectLicense(l.id)}
                  style={[styles.licRow, {
                    borderColor: picked ? colors.primary : colors.border,
                    backgroundColor: picked ? colors.primary + "15" : colors.card,
                  }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${l.type}${l.level != null ? `, level ${l.level}` : ""}, number ${l.licenseNumber}, expires ${l.expiryDate}`}
                  accessibilityHint="Select this license to renew"
                  accessibilityState={{ selected: picked }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.licType, { color: colors.foreground }]}>
                      {l.type}{l.level != null ? ` · L${l.level}` : ""}
                    </Text>
                    <Text style={[styles.licMeta, { color: colors.mutedForeground }]}>
                      #{l.licenseNumber} · expires {l.expiryDate}
                    </Text>
                  </View>
                  {picked && <Feather name="check-circle" size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              onPress={() => selectLicense("new")}
              style={[styles.licRow, {
                borderColor: renewLicenseId === "new" ? colors.primary : colors.border,
                backgroundColor: renewLicenseId === "new" ? colors.primary + "15" : colors.card,
                borderStyle: "dashed",
              }]}
              accessibilityRole="button"
              accessibilityLabel="New license"
              accessibilityHint="Add a license that is not in your list"
              accessibilityState={{ selected: renewLicenseId === "new" }}
            >
              <Feather name="plus-circle" size={16} color={colors.primary} />
              <Text style={[styles.licType, { color: colors.foreground, marginLeft: 8 }]}>New license</Text>
            </TouchableOpacity>
          </View>

          {pendingForSelected && (
            <View style={[styles.warnBox, { borderColor: STATUS_COLOR.pending, backgroundColor: STATUS_COLOR.pending + "18" }]}>
              <Feather name="info" size={14} color={STATUS_COLOR.pending} />
              <Text style={{ color: colors.foreground, fontSize: 12, marginLeft: 6, flex: 1 }}>
                You already have a pending renewal for this license. Submitting again will be rejected — wait for admin review.
              </Text>
            </View>
          )}

          {renewLicenseId != null && (
            <View style={{ marginTop: 14, gap: 10 }}>
              <Field label="License type" value={licenseType} onChange={setLicenseType} colors={colors} placeholder="e.g. TX Level III Commissioned" />
              <Field label="License number" value={licenseNumber} onChange={setLicenseNumber} colors={colors} placeholder="e.g. TX-12345678" />

              <Text style={[styles.label, { color: colors.foreground }]}>Level</Text>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {LEVEL_OPTIONS.map((opt) => {
                  const picked = level === opt.value;
                  return (
                    <TouchableOpacity
                      key={opt.value}
                      onPress={() => setLevel(picked ? null : opt.value)}
                      style={[styles.levelBtn, {
                        borderColor: picked ? colors.primary : colors.border,
                        backgroundColor: picked ? colors.primary + "20" : "transparent",
                      }]}
                      accessibilityRole="button"
                      accessibilityLabel={opt.label}
                      accessibilityState={{ selected: picked }}
                    >
                      <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: picked ? "700" : "500" }}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Field label="Issuing authority (optional)" value={issuingAuthority} onChange={setIssuingAuthority} colors={colors} placeholder="e.g. TX DPS" />
              <Field label="Issue date (YYYY-MM-DD, optional)" value={issueDate} onChange={setIssueDate} colors={colors} placeholder="2026-05-16" />
              <Field label="New expiry date (YYYY-MM-DD)" value={expiryDate} onChange={setExpiryDate} colors={colors} placeholder="2028-05-16" />
              <Field label="Notes (optional)" value={notes} onChange={setNotes} colors={colors} placeholder="Anything the admin should know" multiline />

              <Text style={[styles.label, { color: colors.foreground, marginTop: 6 }]}>Photo of renewed license</Text>
              {uploaded ? (
                <View style={[styles.thumbBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
                  <Image source={{ uri: uploaded.localUri }} style={styles.thumb} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>{uploaded.name}</Text>
                    <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>{Math.round(uploaded.size / 1024)} KB</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setUploaded(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Remove attached photo"
                  >
                    <Feather name="x" size={16} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => pickPhoto("camera")}
                    disabled={uploading}
                    style={[styles.uploadBtn, { borderColor: colors.border, opacity: uploading ? 0.6 : 1 }]}
                    accessibilityRole="button"
                    accessibilityLabel="Take photo of renewed license with camera"
                    accessibilityState={{ disabled: uploading, busy: uploading }}
                  >
                    {uploading ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="camera" size={16} color={colors.primary} />}
                    <Text style={{ color: colors.foreground, fontSize: 13, marginLeft: 6 }}>Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => pickPhoto("library")}
                    disabled={uploading}
                    style={[styles.uploadBtn, { borderColor: colors.border, opacity: uploading ? 0.6 : 1 }]}
                    accessibilityRole="button"
                    accessibilityLabel="Choose photo of renewed license from library"
                    accessibilityState={{ disabled: uploading, busy: uploading }}
                  >
                    {uploading ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="image" size={16} color={colors.primary} />}
                    <Text style={{ color: colors.foreground, fontSize: 13, marginLeft: 6 }}>Library</Text>
                  </TouchableOpacity>
                </View>
              )}

              <TouchableOpacity
                onPress={submit}
                disabled={submitting}
                style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Submit renewal for review"
                accessibilityState={{ disabled: submitting, busy: submitting }}
              >
                {submitting ? <ActivityIndicator color="#fff" /> : <Feather name="upload" size={16} color="#fff" />}
                <Text style={[styles.submitText, { color: "#fff" }]}>
                  {submitting ? "Submitting…" : "Submit for review"}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, colors, placeholder, multiline }: {
  label: string; value: string; onChange: (s: string) => void;
  colors: any; placeholder?: string; multiline?: boolean;
}) {
  return (
    <View>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        multiline={multiline}
        accessibilityLabel={label}
        style={[styles.input, {
          color: colors.foreground,
          backgroundColor: colors.card,
          borderColor: colors.border,
          minHeight: multiline ? 60 : undefined,
          textAlignVertical: multiline ? "top" : "auto",
        }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 6 },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  sectionTitle: { fontSize: 16, fontWeight: "700" },
  help: { fontSize: 12, marginTop: 6, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  licRow: { flexDirection: "row", alignItems: "center", borderWidth: 1.5, borderRadius: 10, padding: 12 },
  licType: { fontSize: 14, fontWeight: "700" },
  licMeta: { fontSize: 12, marginTop: 2 },
  levelBtn: { flex: 1, borderWidth: 1.5, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  warnBox: { flexDirection: "row", alignItems: "center", marginTop: 10, padding: 10, borderRadius: 8, borderWidth: 1 },
  thumbBox: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 8, borderWidth: 1 },
  thumb: { width: 48, height: 48, borderRadius: 6 },
  uploadBtn: { flexDirection: "row", alignItems: "center", flex: 1, borderWidth: 1.5, borderRadius: 8, paddingVertical: 12, justifyContent: "center" },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 10, paddingVertical: 14, marginTop: 10 },
  submitText: { fontSize: 15, fontWeight: "700" },
  histCard: { borderWidth: 1, borderRadius: 10, padding: 12 },
  histHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  histType: { fontSize: 14, fontWeight: "700" },
  histMeta: { fontSize: 12, marginTop: 2 },
  histNote: { fontSize: 12, fontStyle: "italic", marginTop: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  pillText: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
});
