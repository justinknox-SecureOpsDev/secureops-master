import React, { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Platform, Alert, Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import {
  useGetEmployee, getGetEmployeeQueryKey,
  useUpdateMyEmployeeProfile,
} from "@workspace/api-client-react";
import { pickAndUploadImage } from "@/utils/upload";
import { apiRequest } from "@/utils/api";

async function openOwnedDoc(path: string) {
  try {
    const { url } = await apiRequest(`/me/storage/sign?path=${encodeURIComponent(path)}`);
    const can = await Linking.canOpenURL(url);
    if (can) await Linking.openURL(url);
    else Alert.alert("Cannot open file", "No app on this device can open the file.");
  } catch (e) {
    Alert.alert("Could not open file", (e as Error).message ?? "Unknown error");
  }
}

type Form = {
  phone: string;
  address: string;
  emergencyContactName: string;
  emergencyContactRelationship: string;
  emergencyContactPhone: string;
  uniformShirt: string;
  uniformTrousers: string;
  uniformJacket: string;
  uniformBoots: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankBsb: string;
  skills: string;
  // Document keys (object paths) the officer may swap. null = no change
  // pending; new "/objects/<uuid>" string = file uploaded this session.
  photoKey: string | null;
  licenseDocKey: string | null;
  passportDocKey: string | null;
  /** Officers can append new certs and remove existing ones; staged locally until Save. */
  trainingCertificateKeys: string[] | null;
};

const empty: Form = {
  phone: "", address: "",
  emergencyContactName: "", emergencyContactRelationship: "", emergencyContactPhone: "",
  uniformShirt: "", uniformTrousers: "", uniformJacket: "", uniformBoots: "",
  bankAccountName: "", bankAccountNumber: "", bankBsb: "",
  skills: "",
  photoKey: null, licenseDocKey: null, passportDocKey: null,
  trainingCertificateKeys: null,
};

export default function EditProfileScreen() {
  const colors = useColors();
  const router = useRouter();
  const qc = useQueryClient();
  const { user, updateUser } = useAuth();
  const userId = user?.id;
  const isFirstRun = user?.mustCompleteProfile === true;

  const { data: profile, isLoading } = useGetEmployee(userId!, {
    query: { queryKey: getGetEmployeeQueryKey(userId!), enabled: !!userId },
  });

  const [form, setForm] = useState<Form>(empty);
  const [error, setError] = useState<string | null>(null);
  const mut = useUpdateMyEmployeeProfile();

  useEffect(() => {
    if (!profile) return;
    setForm({
      phone: profile.phone ?? "",
      address: profile.address ?? "",
      emergencyContactName: profile.emergencyContactName ?? "",
      emergencyContactRelationship: profile.emergencyContactRelationship ?? "",
      emergencyContactPhone: profile.emergencyContactPhone ?? "",
      uniformShirt: profile.uniformShirt ?? "",
      uniformTrousers: profile.uniformTrousers ?? "",
      uniformJacket: profile.uniformJacket ?? "",
      uniformBoots: profile.uniformBoots ?? "",
      bankAccountName: profile.bankAccountName ?? "",
      bankAccountNumber: profile.bankAccountNumber ?? "",
      bankBsb: profile.bankBsb ?? "",
      skills: (profile.skills ?? []).join(", "),
      photoKey: profile.photoKey ?? null,
      licenseDocKey: profile.licenseDocKey ?? null,
      passportDocKey: profile.passportDocKey ?? null,
      trainingCertificateKeys: profile.trainingCertificateKeys ?? null,
    });
  }, [profile]);

  function set<K extends keyof Form>(k: K, v: string) { setForm((f) => ({ ...f, [k]: v })); }
  function setDoc<K extends "photoKey" | "licenseDocKey" | "passportDocKey">(k: K, v: string | null) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function appendCert(v: string) {
    setForm((f) => ({ ...f, trainingCertificateKeys: [...(f.trainingCertificateKeys ?? []), v] }));
  }
  function removeCert(idx: number) {
    setForm((f) => {
      const next = [...(f.trainingCertificateKeys ?? [])];
      next.splice(idx, 1);
      return { ...f, trainingCertificateKeys: next };
    });
  }
  function confirmRemoveCert(idx: number) {
    const doRemove = () => removeCert(idx);
    if (Platform.OS === "web") {
      // eslint-disable-next-line no-alert
      if (typeof window !== "undefined" && window.confirm("Remove this training certificate? You can re-upload it any time.")) {
        doRemove();
      }
      return;
    }
    Alert.alert(
      "Remove certificate?",
      "This will remove the certificate from your profile when you save. You can upload a fresh copy any time.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: doRemove },
      ],
    );
  }

  const [uploading, setUploading] = useState<string | null>(null);
  async function handleUpload(
    field: "photoKey" | "licenseDocKey" | "passportDocKey" | "trainingCertificateKeys",
    source: "library" | "camera",
  ) {
    try {
      setUploading(`${field}:${source}`);
      const res = await pickAndUploadImage({ source, quality: 0.7 });
      if (!res) return;
      if (field === "trainingCertificateKeys") appendCert(res.objectPath);
      else setDoc(field, res.objectPath);
    } catch (e) {
      const msg = (e as Error).message ?? "Could not upload file";
      if (source === "camera" && /camera permission/i.test(msg)) {
        Alert.alert(
          "Camera access needed",
          "To snap a photo of your license or passport right from the field, allow camera access in your device Settings. You can still pick an existing image from your photo library.",
        );
      } else if (source === "library" && /photo library permission/i.test(msg)) {
        Alert.alert(
          "Photo library access needed",
          "Allow photo library access in your device Settings to pick an existing image, or use 'Take photo' instead.",
        );
      } else {
        Alert.alert("Upload failed", msg);
      }
    } finally {
      setUploading(null);
    }
  }

  async function save() {
    setError(null);
    const payload: Record<string, unknown> = {};
    const trim = (s: string) => s.trim();
    if (trim(form.phone)) payload.phone = trim(form.phone);
    if (trim(form.address)) payload.address = trim(form.address);
    if (trim(form.emergencyContactName)) payload.emergencyContactName = trim(form.emergencyContactName);
    payload.emergencyContactRelationship = trim(form.emergencyContactRelationship) || null;
    if (trim(form.emergencyContactPhone)) payload.emergencyContactPhone = trim(form.emergencyContactPhone);
    payload.uniformShirt = trim(form.uniformShirt) || null;
    payload.uniformTrousers = trim(form.uniformTrousers) || null;
    payload.uniformJacket = trim(form.uniformJacket) || null;
    payload.uniformBoots = trim(form.uniformBoots) || null;
    payload.bankAccountName = trim(form.bankAccountName) || null;
    payload.bankAccountNumber = trim(form.bankAccountNumber) || null;
    payload.bankBsb = trim(form.bankBsb) || null;
    const skills = form.skills.split(",").map((s) => s.trim()).filter(Boolean);
    payload.skills = skills;
    // Only send doc keys that actually changed from what's on the profile.
    if (form.photoKey !== (profile?.photoKey ?? null)) payload.photoKey = form.photoKey;
    if (form.licenseDocKey !== (profile?.licenseDocKey ?? null)) payload.licenseDocKey = form.licenseDocKey;
    if (form.passportDocKey !== (profile?.passportDocKey ?? null)) payload.passportDocKey = form.passportDocKey;
    const origCerts = profile?.trainingCertificateKeys ?? null;
    const newCerts = form.trainingCertificateKeys ?? null;
    if (JSON.stringify(origCerts) !== JSON.stringify(newCerts)) {
      payload.trainingCertificateKeys = newCerts;
    }
    try {
      await mut.mutateAsync({ data: payload as any });
      await updateUser({ mustCompleteProfile: false });
      qc.invalidateQueries({ queryKey: getGetEmployeeQueryKey(userId!) });
      if (isFirstRun) {
        if (user?.role === "admin") router.replace("/(admin)/dashboard");
        else router.replace("/(employee)/home");
      } else {
        router.back();
      }
    } catch (e) {
      setError((e as Error).message || "Could not save profile");
    }
  }

  if (isLoading || !profile) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!isFirstRun && (
          <TouchableOpacity onPress={() => router.back()} style={styles.backRow}>
            <Feather name="chevron-left" size={20} color={colors.foreground} />
            <Text style={{ color: colors.foreground }}>Back</Text>
          </TouchableOpacity>
        )}

        <Text style={[styles.title, { color: colors.foreground }]}>Edit profile</Text>
        {isFirstRun && (
          <View style={[styles.banner, { backgroundColor: colors.primary + "15", borderColor: colors.primary }]}>
            <Feather name="info" size={16} color={colors.primary} />
            <Text style={{ color: colors.foreground, flex: 1, fontSize: 13, lineHeight: 18 }}>
              Welcome! Please review and update the details we copied from your application. You can change these any time.
            </Text>
          </View>
        )}

        <Section title="Read-only">
          <ReadOnly label="Email" value={profile.email} />
          <ReadOnly label="Name" value={`${profile.firstName} ${profile.lastName}`} />
          <ReadOnly label="Role" value={profile.role ?? "employee"} />
          {profile.hourlyRate != null && <ReadOnly label="Hourly rate" value={`$${parseFloat(profile.hourlyRate as any).toFixed(2)}`} />}
          {profile.siaLicenseNumber && <ReadOnly label="License" value={`L${profile.siaLicenseLevel ?? "?"} · ${profile.siaLicenseNumber}`} />}
          <Text style={[styles.note, { color: colors.mutedForeground }]}>Contact admin to change the fields above.</Text>
        </Section>

        <Section title="Contact">
          <Field label="Phone"><Input value={form.phone} onChangeText={(v) => set("phone", v)} /></Field>
          <Field label="Address"><Input value={form.address} onChangeText={(v) => set("address", v)} multiline /></Field>
        </Section>

        <Section title="Emergency contact">
          <Field label="Name"><Input value={form.emergencyContactName} onChangeText={(v) => set("emergencyContactName", v)} /></Field>
          <Field label="Relationship"><Input value={form.emergencyContactRelationship} onChangeText={(v) => set("emergencyContactRelationship", v)} /></Field>
          <Field label="Phone"><Input value={form.emergencyContactPhone} onChangeText={(v) => set("emergencyContactPhone", v)} keyboardType="phone-pad" /></Field>
        </Section>

        <Section title="Uniform sizes">
          <Field label="Shirt"><Input value={form.uniformShirt} onChangeText={(v) => set("uniformShirt", v)} /></Field>
          <Field label="Trousers"><Input value={form.uniformTrousers} onChangeText={(v) => set("uniformTrousers", v)} /></Field>
          <Field label="Jacket"><Input value={form.uniformJacket} onChangeText={(v) => set("uniformJacket", v)} /></Field>
          <Field label="Boots"><Input value={form.uniformBoots} onChangeText={(v) => set("uniformBoots", v)} /></Field>
        </Section>

        <Section title="Bank details">
          <Field label="Account name"><Input value={form.bankAccountName} onChangeText={(v) => set("bankAccountName", v)} /></Field>
          <Field label="Account number"><Input value={form.bankAccountNumber} onChangeText={(v) => set("bankAccountNumber", v)} keyboardType="number-pad" /></Field>
          <Field label="Routing / sort code"><Input value={form.bankBsb} onChangeText={(v) => set("bankBsb", v)} /></Field>
        </Section>

        <Section title="Documents">
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            Replace your photo or snap refreshed pictures of your TX security license, passport / right-to-work doc, or training certificates. Image uploads only — for PDF certificates, ask admin to upload from the office. Files are private and only visible to admin.
          </Text>
          <DocRow
            label="Profile photo"
            current={form.photoKey}
            originalKey={profile?.photoKey ?? null}
            uploadingSource={uploading?.startsWith("photoKey:") ? (uploading.split(":")[1] as "library" | "camera") : null}
            onUpload={(source) => handleUpload("photoKey", source)}
            onClear={() => setDoc("photoKey", null)}
          />
          <DocRow
            label="TX security license (photo of card)"
            current={form.licenseDocKey}
            originalKey={profile?.licenseDocKey ?? null}
            uploadingSource={uploading?.startsWith("licenseDocKey:") ? (uploading.split(":")[1] as "library" | "camera") : null}
            onUpload={(source) => handleUpload("licenseDocKey", source)}
            onClear={() => setDoc("licenseDocKey", null)}
          />
          <DocRow
            label="Passport / driver's license"
            current={form.passportDocKey}
            originalKey={profile?.passportDocKey ?? null}
            uploadingSource={uploading?.startsWith("passportDocKey:") ? (uploading.split(":")[1] as "library" | "camera") : null}
            onUpload={(source) => handleUpload("passportDocKey", source)}
            onClear={() => setDoc("passportDocKey", null)}
          />
          <View style={{ gap: 6 }}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              Training certificates ({(form.trainingCertificateKeys ?? []).length} on file)
            </Text>
            {(form.trainingCertificateKeys ?? []).length > 0 && (
              <View style={{ gap: 6 }}>
                {(form.trainingCertificateKeys ?? []).map((key, i) => {
                  const origCerts = (profile?.trainingCertificateKeys ?? []) as string[];
                  const isExisting = origCerts.includes(key);
                  return (
                    <View
                      key={key + i}
                      style={[styles.certRow, { borderColor: colors.border, backgroundColor: colors.secondary }]}
                    >
                      <Feather name="award" size={14} color={colors.accent} />
                      <Text style={{ flex: 1, color: colors.foreground, fontSize: 13 }} numberOfLines={1}>
                        Certificate {i + 1}{isExisting ? "" : " · just added"}
                      </Text>
                      {isExisting && (
                        <TouchableOpacity onPress={() => openOwnedDoc(key)} style={styles.certAction}>
                          <Feather name="eye" size={13} color={colors.primary} />
                          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}>View</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => confirmRemoveCert(i)} style={styles.certAction}>
                        <Feather name="trash-2" size={13} color={colors.destructive} />
                        <Text style={{ color: colors.destructive, fontSize: 12, fontWeight: "600" }}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                onPress={() => handleUpload("trainingCertificateKeys", "camera")}
                disabled={!!uploading}
                style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
              >
                {uploading === "trainingCertificateKeys:camera" ? <ActivityIndicator color={colors.primary} /> : (
                  <>
                    <Feather name="camera" size={14} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>Take photo</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleUpload("trainingCertificateKeys", "library")}
                disabled={!!uploading}
                style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
              >
                {uploading === "trainingCertificateKeys:library" ? <ActivityIndicator color={colors.primary} /> : (
                  <>
                    <Feather name="image" size={14} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>Choose from library</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
            <Text style={[styles.note, { color: colors.mutedForeground }]}>
              Removed certificates are deleted from your profile when you save.
            </Text>
          </View>
        </Section>

        <Section title="Skills">
          <Field label="Comma-separated">
            <Input value={form.skills} onChangeText={(v) => set("skills", v)} placeholder="e.g. CPR, Crowd control, First aid" />
          </Field>
        </Section>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={{ color: colors.destructive, flex: 1, fontSize: 13 }}>{error}</Text>
          </View>
        )}

        <TouchableOpacity onPress={save} disabled={mut.isPending} style={[styles.button, { backgroundColor: colors.primary, opacity: mut.isPending ? 0.7 : 1 }]}>
          {mut.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{isFirstRun ? "Save and continue" : "Save changes"}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.section, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Text style={[styles.sectionTitle, { color: colors.accent }]}>{title.toUpperCase()}</Text>
      <View style={{ gap: 10 }}>{children}</View>
    </View>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {children}
    </View>
  );
}
function Input(props: React.ComponentProps<typeof TextInput>) {
  const colors = useColors();
  return (
    <TextInput
      placeholderTextColor={colors.mutedForeground}
      {...props}
      style={[
        { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary,
          borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
        props.style,
      ]}
    />
  );
}
function DocRow({
  label, current, originalKey, uploadingSource, onUpload, onClear,
}: {
  label: string;
  current: string | null;
  originalKey: string | null;
  uploadingSource: "library" | "camera" | null;
  onUpload: (source: "library" | "camera") => void;
  onClear: () => void;
}) {
  const colors = useColors();
  const hasFile = !!current;
  const busy = uploadingSource !== null;
  const viewableKey = current && current === originalKey ? current : null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TouchableOpacity
          onPress={() => onUpload("camera")}
          disabled={busy}
          style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
        >
          {uploadingSource === "camera" ? <ActivityIndicator color={colors.primary} /> : (
            <>
              <Feather name="camera" size={14} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>Take photo</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onUpload("library")}
          disabled={busy}
          style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
        >
          {uploadingSource === "library" ? <ActivityIndicator color={colors.primary} /> : (
            <>
              <Feather name={hasFile ? "refresh-cw" : "image"} size={14} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>
                {hasFile ? "Replace from library" : "Choose from library"}
              </Text>
            </>
          )}
        </TouchableOpacity>
        {hasFile && (
          <TouchableOpacity onPress={onClear} disabled={busy} style={[styles.docBtn, { borderColor: colors.border }]}>
            <Feather name="x" size={14} color={colors.foreground} />
          </TouchableOpacity>
        )}
      </View>
      {hasFile && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 2 }}>
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            <Feather name="check" size={11} color={colors.accent} /> {viewableKey ? "File on record" : "New file selected (save to upload)"}
          </Text>
          {viewableKey && (
            <TouchableOpacity onPress={() => openOwnedDoc(viewableKey)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Feather name="eye" size={12} color={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}>View current file</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}
function ReadOnly({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={{ color: colors.foreground, fontSize: 14 }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  content: { padding: 16, gap: 14, paddingTop: Platform.OS === "web" ? 80 : 12, paddingBottom: 80 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  title: { fontSize: 24, fontWeight: "700" },
  banner: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, borderWidth: 1 },
  section: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 10 },
  sectionTitle: { fontSize: 11, letterSpacing: 2, fontWeight: "700" },
  label: { fontSize: 11, letterSpacing: 1, fontWeight: "700", textTransform: "uppercase" },
  note: { fontSize: 11, fontStyle: "italic" },
  docBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  certRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  certAction: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 4 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  button: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});
