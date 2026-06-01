import React, { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Platform, Alert, Linking,
  Image, Modal, Pressable, AccessibilityInfo, findNodeHandle,
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

async function signOwnedDoc(path: string): Promise<string> {
  const { url } = await apiRequest(`/me/storage/sign?path=${encodeURIComponent(path)}`);
  return url as string;
}

async function openOwnedDoc(path: string) {
  try {
    const url = await signOwnedDoc(path);
    const can = await Linking.canOpenURL(url);
    if (can) await Linking.openURL(url);
    else Alert.alert("Cannot open file", "No app on this device can open the file.");
  } catch (e) {
    Alert.alert("Could not open file", (e as Error).message ?? "Unknown error");
  }
}

/** Resolves an inline thumbnail URL for a doc key the caller owns. Local
 * URIs (newly captured this session) win — no round-trip needed. Otherwise
 * we ask the server for a short-lived signed GET URL. Returns null while
 * loading / on error so the caller can render a graceful fallback. */
function useDocPreview(objectKey: string | null, localUri: string | null): string | null {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (localUri) { setSignedUrl(null); return; }
    if (!objectKey) { setSignedUrl(null); return; }
    let cancelled = false;
    setSignedUrl(null);
    signOwnedDoc(objectKey)
      .then((url) => { if (!cancelled) setSignedUrl(url); })
      .catch(() => { if (!cancelled) setSignedUrl(null); });
    return () => { cancelled = true; };
  }, [objectKey, localUri]);
  return localUri ?? signedUrl;
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
  const [invalid, setInvalid] = useState<{ emergencyContactName: boolean; emergencyContactPhone: boolean }>({ emergencyContactName: false, emergencyContactPhone: false });
  const emName = React.useRef<TextInput>(null);
  const emPhone = React.useRef<TextInput>(null);
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
  /** Local URIs for images uploaded *this session* — keyed by objectPath so
   * we can render an instant thumbnail without re-fetching from the server. */
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  /** Currently-open full-size preview (modal). */
  const [preview, setPreview] = useState<{ uri: string; label: string } | null>(null);
  async function handleUpload(
    field: "photoKey" | "licenseDocKey" | "passportDocKey" | "trainingCertificateKeys",
    source: "library" | "camera",
  ) {
    try {
      setUploading(`${field}:${source}`);
      const res = await pickAndUploadImage({ source, quality: 0.7 });
      if (!res) return;
      setLocalPreviews((m) => ({ ...m, [res.objectPath]: res.localUri }));
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

  const [hrToast, setHrToast] = useState<string[] | null>(null);
  async function save() {
    setError(null);
    const trim = (s: string) => s.trim();
    const nameMissing = !trim(form.emergencyContactName);
    const phoneMissing = !trim(form.emergencyContactPhone);
    if (nameMissing || phoneMissing) {
      setInvalid({ emergencyContactName: nameMissing, emergencyContactPhone: phoneMissing });
      const missing = [nameMissing && "emergency contact name", phoneMissing && "emergency contact phone"].filter(Boolean).join(" and ");
      const msg = `Cannot save. Missing required ${missing}.`;
      setError(msg);
      AccessibilityInfo.announceForAccessibility(msg);
      const target = nameMissing ? emName.current : emPhone.current;
      if (target) {
        const node = findNodeHandle(target);
        if (node != null) { try { AccessibilityInfo.setAccessibilityFocus?.(node); } catch { /* best effort */ } }
        try { target.focus?.(); } catch { /* best effort */ }
      }
      return;
    }
    setInvalid({ emergencyContactName: false, emergencyContactPhone: false });
    const payload: Record<string, unknown> = {};
    if (trim(form.phone)) payload.phone = trim(form.phone);
    if (trim(form.address)) payload.address = trim(form.address);
    payload.emergencyContactName = trim(form.emergencyContactName);
    payload.emergencyContactRelationship = trim(form.emergencyContactRelationship) || null;
    payload.emergencyContactPhone = trim(form.emergencyContactPhone);
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
      // The server returns { …Employee, hrNotified, hrNotifiedFields[] } when
      // a self-edit touches a high-risk field (banking, emergency contact, …).
      // We surface that as a one-shot toast so officers see HR has been
      // looped in — quietly when it didn't fire (most saves), explicitly
      // when it did. Typed via the OpenAPI-generated UpdateMyEmployeeResponse.
      const resp = await mut.mutateAsync({ data: payload as any });
      await updateUser({ mustCompleteProfile: false });
      qc.invalidateQueries({ queryKey: getGetEmployeeQueryKey(userId!) });
      const notified = resp?.hrNotified === true && (resp?.hrNotifiedFields?.length ?? 0) > 0;
      if (isFirstRun) {
        if (user?.role === "admin") router.replace("/(admin)/dashboard");
        else router.replace("/(employee)/home");
      } else if (notified) {
        // Hold the screen open just long enough to show the confirmation,
        // then go back automatically.
        setHrToast(resp.hrNotifiedFields ?? []);
        setTimeout(() => { router.back(); }, 2200);
      } else {
        router.back();
      }
    } catch (e) {
      setError((e as Error).message || "Could not save profile");
    }
  }

  const FIELD_LABELS_MOBILE: Record<string, string> = {
    bankAccountName: "bank account name",
    bankAccountNumber: "bank account number",
    bankBsb: "routing / sort code",
    emergencyContactName: "emergency contact name",
    emergencyContactRelationship: "emergency contact relationship",
    emergencyContactPhone: "emergency contact phone",
  };

  if (isLoading || !profile) {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!isFirstRun && (
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backRow}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="chevron-left" size={20} color={colors.foreground} />
            <Text style={{ color: colors.foreground }}>Back</Text>
          </TouchableOpacity>
        )}

        <Text style={[styles.title, { color: colors.foreground }]} accessibilityRole="header">Edit profile</Text>
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

        <Section title="License updates">
          <Text style={[styles.note, { color: colors.mutedForeground, marginBottom: 8 }]}>
            Upgraded to L3 (armed) or L4 (PPO), or renewed your existing license? Submit the new card here and an admin will review it. Your displayed license level updates once approved.
          </Text>
          <TouchableOpacity
            onPress={() => router.push("/license-renewal" as any)}
            style={{
              flexDirection: "row", alignItems: "center", gap: 12,
              backgroundColor: colors.primary + "15", borderColor: colors.primary, borderWidth: 1,
              borderRadius: 8, padding: 12,
            }}
            accessibilityRole="button"
            accessibilityLabel="Submit a license update for admin review"
          >
            <Feather name="shield" size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Submit license update</Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
                Upload the new card, level, and expiry for admin approval
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        </Section>

        <Section title="Contact">
          <Field label="Phone"><Input value={form.phone} onChangeText={(v) => set("phone", v)} accessibilityLabel="Phone" keyboardType="phone-pad" /></Field>
          <Field label="Address"><Input value={form.address} onChangeText={(v) => set("address", v)} multiline accessibilityLabel="Address" /></Field>
        </Section>

        <Section title="Emergency contact">
          <Field label="Name" required invalid={invalid.emergencyContactName} errorText="Emergency contact name is required.">
            <Input
              ref={emName}
              value={form.emergencyContactName}
              onChangeText={(v) => { set("emergencyContactName", v); if (invalid.emergencyContactName && v) setInvalid((i) => ({ ...i, emergencyContactName: false })); }}
              accessibilityLabel={`Emergency contact name, required${invalid.emergencyContactName ? ", invalid, emergency contact name is required" : ""}`}
              borderColor={invalid.emergencyContactName ? "error" : undefined}
            />
          </Field>
          <Field label="Relationship">
            <Input
              value={form.emergencyContactRelationship}
              onChangeText={(v) => set("emergencyContactRelationship", v)}
              accessibilityLabel="Emergency contact relationship"
            />
          </Field>
          <Field label="Phone" required invalid={invalid.emergencyContactPhone} errorText="Emergency contact phone is required.">
            <Input
              ref={emPhone}
              value={form.emergencyContactPhone}
              onChangeText={(v) => { set("emergencyContactPhone", v); if (invalid.emergencyContactPhone && v) setInvalid((i) => ({ ...i, emergencyContactPhone: false })); }}
              keyboardType="phone-pad"
              accessibilityLabel={`Emergency contact phone, required${invalid.emergencyContactPhone ? ", invalid, emergency contact phone is required" : ""}`}
              borderColor={invalid.emergencyContactPhone ? "error" : undefined}
            />
          </Field>
          <NotifiedNote />
        </Section>

        <Section title="Uniform sizes">
          <Field label="Shirt"><Input value={form.uniformShirt} onChangeText={(v) => set("uniformShirt", v)} accessibilityLabel="Shirt size" /></Field>
          <Field label="Trousers"><Input value={form.uniformTrousers} onChangeText={(v) => set("uniformTrousers", v)} accessibilityLabel="Trousers size" /></Field>
          <Field label="Jacket"><Input value={form.uniformJacket} onChangeText={(v) => set("uniformJacket", v)} accessibilityLabel="Jacket size" /></Field>
          <Field label="Boots"><Input value={form.uniformBoots} onChangeText={(v) => set("uniformBoots", v)} accessibilityLabel="Boots size" /></Field>
        </Section>

        <Section title="Bank details">
          <Field label="Account name"><Input value={form.bankAccountName} onChangeText={(v) => set("bankAccountName", v)} accessibilityLabel="Bank account name" /></Field>
          <Field label="Account number"><Input value={form.bankAccountNumber} onChangeText={(v) => set("bankAccountNumber", v)} keyboardType="number-pad" accessibilityLabel="Bank account number" /></Field>
          <Field label="Routing / sort code"><Input value={form.bankBsb} onChangeText={(v) => set("bankBsb", v)} accessibilityLabel="Routing or sort code" /></Field>
          <NotifiedNote />
        </Section>

        <Section title="Documents">
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            Replace your photo or snap refreshed pictures of your TX security license, passport / right-to-work doc, or training certificates. Image uploads only — for PDF certificates, ask admin to upload from the office. Files are private and only visible to admin.
          </Text>
          <DocRow
            label="Profile photo"
            current={form.photoKey}
            originalKey={profile?.photoKey ?? null}
            localUri={form.photoKey ? localPreviews[form.photoKey] ?? null : null}
            uploadingSource={uploading?.startsWith("photoKey:") ? (uploading.split(":")[1] as "library" | "camera") : null}
            onUpload={(source) => handleUpload("photoKey", source)}
            onClear={() => setDoc("photoKey", null)}
            onPreview={(uri) => setPreview({ uri, label: "Profile photo" })}
          />
          <DocRow
            label="TX security license (photo of card)"
            current={form.licenseDocKey}
            originalKey={profile?.licenseDocKey ?? null}
            localUri={form.licenseDocKey ? localPreviews[form.licenseDocKey] ?? null : null}
            uploadingSource={uploading?.startsWith("licenseDocKey:") ? (uploading.split(":")[1] as "library" | "camera") : null}
            onUpload={(source) => handleUpload("licenseDocKey", source)}
            onClear={() => setDoc("licenseDocKey", null)}
            onPreview={(uri) => setPreview({ uri, label: "TX security license" })}
          />
          <DocRow
            label="Passport / driver's license"
            current={form.passportDocKey}
            originalKey={profile?.passportDocKey ?? null}
            localUri={form.passportDocKey ? localPreviews[form.passportDocKey] ?? null : null}
            uploadingSource={uploading?.startsWith("passportDocKey:") ? (uploading.split(":")[1] as "library" | "camera") : null}
            onUpload={(source) => handleUpload("passportDocKey", source)}
            onClear={() => setDoc("passportDocKey", null)}
            onPreview={(uri) => setPreview({ uri, label: "Passport / driver's license" })}
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
                    <CertRow
                      key={key + i}
                      objectKey={key}
                      localUri={localPreviews[key] ?? null}
                      label={`Certificate ${i + 1}${isExisting ? "" : " · just added"}`}
                      onPreview={(uri) => setPreview({ uri, label: `Certificate ${i + 1}` })}
                      onRemove={() => confirmRemoveCert(i)}
                    />
                  );
                })}
              </View>
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                onPress={() => handleUpload("trainingCertificateKeys", "camera")}
                disabled={!!uploading}
                style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Take photo of training certificate"
                accessibilityState={{ disabled: !!uploading, busy: uploading === "trainingCertificateKeys:camera" }}
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
                accessibilityRole="button"
                accessibilityLabel="Choose training certificate from library"
                accessibilityState={{ disabled: !!uploading, busy: uploading === "trainingCertificateKeys:library" }}
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
            <Input value={form.skills} onChangeText={(v) => set("skills", v)} placeholder="e.g. CPR, Crowd control, First aid" accessibilityLabel="Skills, comma-separated" />
          </Field>
        </Section>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={14} color={colors.destructive} />
            <Text style={{ color: colors.destructive, flex: 1, fontSize: 13 }}>{error}</Text>
          </View>
        )}

        {hrToast && (
          <View style={[styles.banner, { backgroundColor: colors.primary + "15", borderColor: colors.primary }]}>
            <Feather name="check-circle" size={16} color={colors.primary} />
            <Text style={{ color: colors.foreground, flex: 1, fontSize: 13, lineHeight: 18 }}>
              HR was notified of this change
              {hrToast.length === 1 && FIELD_LABELS_MOBILE[hrToast[0]]
                ? ` (${FIELD_LABELS_MOBILE[hrToast[0]]}).`
                : "."}
            </Text>
          </View>
        )}

        <PreviewModal preview={preview} onClose={() => setPreview(null)} />

        <TouchableOpacity
          onPress={save}
          disabled={mut.isPending}
          style={[styles.button, { backgroundColor: colors.primary, opacity: mut.isPending ? 0.7 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={isFirstRun ? "Save and continue" : "Save changes"}
          accessibilityState={{ disabled: mut.isPending, busy: mut.isPending }}
        >
          {mut.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{isFirstRun ? "Save and continue" : "Save changes"}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Inline notice rendered under high-risk sections (banking, emergency contact)
 * so officers understand that any change here triggers a same-day push + email
 * to HR. Matches the server-side HIGH_RISK_SELF_EDIT_FIELDS gate in
 * `routes/employees.ts`. */
function NotifiedNote() {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 2 }}>
      <Feather name="shield" size={12} color={colors.mutedForeground} style={{ marginTop: 2 }} />
      <Text style={[styles.note, { color: colors.mutedForeground, flex: 1 }]}>
        HR is notified when you save changes here.
      </Text>
    </View>
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
function Field({ label, required, invalid, errorText, children }: { label: string; required?: boolean; invalid?: boolean; errorText?: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.label, { color: invalid ? colors.destructive : colors.mutedForeground }]}>
        {label}{required ? " *" : ""}
      </Text>
      {children}
      {invalid && errorText && (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.destructive, fontSize: 11 }}>{errorText}</Text>
      )}
    </View>
  );
}
type InputProps = React.ComponentProps<typeof TextInput> & { borderColor?: "error" };
const Input = React.forwardRef<TextInput, InputProps>(function Input({ borderColor, ...props }, ref) {
  const colors = useColors();
  const border = borderColor === "error" ? colors.destructive : colors.border;
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.mutedForeground}
      {...props}
      style={[
        { color: colors.foreground, borderColor: border, backgroundColor: colors.secondary,
          borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
        props.style,
      ]}
    />
  );
});
function DocRow({
  label, current, originalKey, localUri, uploadingSource, onUpload, onClear, onPreview,
}: {
  label: string;
  current: string | null;
  originalKey: string | null;
  localUri: string | null;
  uploadingSource: "library" | "camera" | null;
  onUpload: (source: "library" | "camera") => void;
  onClear: () => void;
  onPreview: (uri: string) => void;
}) {
  const colors = useColors();
  const hasFile = !!current;
  const busy = uploadingSource !== null;
  const isExisting = !!current && current === originalKey;
  // Only sign existing-on-record keys; new-this-session uploads use localUri.
  const previewUri = useDocPreview(isExisting ? current : null, localUri);
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {hasFile && (
          <Pressable
            onPress={() => previewUri && onPreview(previewUri)}
            disabled={!previewUri}
            style={[styles.thumb, { borderColor: colors.border, backgroundColor: colors.secondary }]}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Preview ${label}`}
          >
            {previewUri ? (
              <Image source={{ uri: previewUri }} style={styles.thumbImg} resizeMode="cover" />
            ) : (
              <ActivityIndicator color={colors.mutedForeground} />
            )}
          </Pressable>
        )}
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TouchableOpacity
            onPress={() => onUpload("camera")}
            disabled={busy}
            style={[styles.docBtn, { borderColor: colors.primary, backgroundColor: colors.primary + "10", flex: 1 }]}
            accessibilityRole="button"
            accessibilityLabel={`Take photo of ${label}`}
            accessibilityState={{ disabled: busy, busy: uploadingSource === "camera" }}
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
            accessibilityRole="button"
            accessibilityLabel={`${hasFile ? "Replace" : "Choose from library"} ${label}`}
            accessibilityState={{ disabled: busy, busy: uploadingSource === "library" }}
          >
            {uploadingSource === "library" ? <ActivityIndicator color={colors.primary} /> : (
              <>
                <Feather name={hasFile ? "refresh-cw" : "image"} size={14} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 13 }}>
                  {hasFile ? "Replace" : "Library"}
                </Text>
              </>
            )}
          </TouchableOpacity>
          {hasFile && (
            <TouchableOpacity
              onPress={onClear}
              disabled={busy}
              style={[styles.docBtn, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label}`}
              accessibilityState={{ disabled: busy }}
            >
              <Feather name="x" size={14} color={colors.foreground} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      {hasFile && (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          <Feather name="check" size={11} color={colors.accent} /> {isExisting ? "File on record · tap thumbnail to preview" : "New file selected (save to upload) · tap thumbnail to preview"}
        </Text>
      )}
    </View>
  );
}

function CertRow({
  objectKey, localUri, label, onPreview, onRemove,
}: {
  objectKey: string;
  localUri: string | null;
  label: string;
  onPreview: (uri: string) => void;
  onRemove: () => void;
}) {
  const colors = useColors();
  const previewUri = useDocPreview(objectKey, localUri);
  return (
    <View style={[styles.certRow, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
      <Pressable
        onPress={() => previewUri && onPreview(previewUri)}
        disabled={!previewUri}
        style={[styles.certThumb, { borderColor: colors.border, backgroundColor: colors.background }]}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Preview ${label}`}
      >
        {previewUri ? (
          <Image source={{ uri: previewUri }} style={styles.thumbImg} resizeMode="cover" />
        ) : (
          <Feather name="award" size={16} color={colors.accent} />
        )}
      </Pressable>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 13 }} numberOfLines={1}>{label}</Text>
      <TouchableOpacity
        onPress={onRemove}
        style={styles.certAction}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label}`}
      >
        <Feather name="trash-2" size={13} color={colors.destructive} />
        <Text style={{ color: colors.destructive, fontSize: 12, fontWeight: "600" }}>Remove</Text>
      </TouchableOpacity>
    </View>
  );
}

function PreviewModal({
  preview, onClose,
}: {
  preview: { uri: string; label: string } | null;
  onClose: () => void;
}) {
  const colors = useColors();
  return (
    <Modal visible={!!preview} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={styles.modalBackdrop}>
        <View style={styles.modalCard} pointerEvents="box-none">
          <View style={[styles.modalHeader, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.foreground, fontWeight: "700", flex: 1 }} numberOfLines={1} accessibilityRole="header">
              {preview?.label ?? "Preview"}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close preview"
            >
              <Feather name="x" size={20} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          {preview && (
            <Image source={{ uri: preview.uri }} style={styles.modalImg} resizeMode="contain" />
          )}
        </View>
      </Pressable>
    </Modal>
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
  thumb: { width: 56, height: 56, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  certThumb: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  thumbImg: { width: "100%", height: "100%" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center", padding: 16 },
  modalCard: { width: "100%", maxWidth: 720, flex: 1, maxHeight: "100%", gap: 8 },
  modalHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  modalImg: { flex: 1, width: "100%", height: undefined },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1 },
  button: { height: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "700", letterSpacing: 1 },
});
