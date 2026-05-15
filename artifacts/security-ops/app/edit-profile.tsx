import React, { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Platform, Alert,
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
  /** Append-only list. We never remove existing certs from this screen. */
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

  const [uploading, setUploading] = useState<string | null>(null);
  async function handleUpload(field: "photoKey" | "licenseDocKey" | "passportDocKey" | "trainingCertificateKeys") {
    try {
      setUploading(field);
      const res = await pickAndUploadImage({ source: "library", quality: 0.7 });
      if (!res) return;
      if (field === "trainingCertificateKeys") appendCert(res.objectPath);
      else setDoc(field, res.objectPath);
    } catch (e) {
      Alert.alert("Upload failed", (e as Error).message ?? "Could not upload file");
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
            Replace your photo or scan refreshed copies of your TX security license, passport / right-to-work doc, or training certificates. Files are private and only visible to admin.
          </Text>
          <DocRow
            label="Profile photo"
            current={form.photoKey}
            uploading={uploading === "photoKey"}
            onUpload={() => handleUpload("photoKey")}
            onClear={() => setDoc("photoKey", null)}
          />
          <DocRow
            label="TX security license (photo of card)"
            current={form.licenseDocKey}
            uploading={uploading === "licenseDocKey"}
            onUpload={() => handleUpload("licenseDocKey")}
            onClear={() => setDoc("licenseDocKey", null)}
          />
          <DocRow
            label="Passport / driver's license"
            current={form.passportDocKey}
            uploading={uploading === "passportDocKey"}
            onUpload={() => handleUpload("passportDocKey")}
            onClear={() => setDoc("passportDocKey", null)}
          />
          <View style={{ gap: 4 }}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              Training certificates ({(form.trainingCertificateKeys ?? []).length} on file)
            </Text>
            <TouchableOpacity
              onPress={() => handleUpload("trainingCertificateKeys")}
              disabled={uploading === "trainingCertificateKeys"}
              style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10" }]}
            >
              {uploading === "trainingCertificateKeys" ? <ActivityIndicator color={colors.primary} /> : (
                <>
                  <Feather name="plus" size={14} color={colors.primary} />
                  <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>Add training certificate</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={[styles.note, { color: colors.mutedForeground }]}>
              Existing certificates remain on file. Contact admin to remove one.
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
  label, current, uploading, onUpload, onClear,
}: {
  label: string;
  current: string | null;
  uploading: boolean;
  onUpload: () => void;
  onClear: () => void;
}) {
  const colors = useColors();
  const hasFile = !!current;
  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TouchableOpacity
          onPress={onUpload}
          disabled={uploading}
          style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
        >
          {uploading ? <ActivityIndicator color={colors.primary} /> : (
            <>
              <Feather name={hasFile ? "refresh-cw" : "upload"} size={14} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>
                {hasFile ? "Replace file" : "Upload file"}
              </Text>
            </>
          )}
        </TouchableOpacity>
        {hasFile && (
          <TouchableOpacity onPress={onClear} style={[styles.docBtn, { borderColor: colors.border }]}>
            <Feather name="x" size={14} color={colors.foreground} />
          </TouchableOpacity>
        )}
      </View>
      {hasFile && (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          <Feather name="check" size={11} color={colors.accent} /> File on record
        </Text>
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
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  button: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});
