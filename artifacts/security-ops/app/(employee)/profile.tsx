import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Image, Switch, Linking, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useGetMe, getGetMeQueryKey, useGetEmployee, getGetEmployeeQueryKey, useGetLicenses, getGetLicensesQueryKey } from "@workspace/api-client-react";
import { LicenseLevelBadge, levelLabel, levelColor } from "@/components/LicenseLevelBadge";
import { useAuth } from "@/contexts/AuthContext";
import { Feather } from "@expo/vector-icons";
import { isBiometricAvailable, isBiometricEnabled, setBiometricEnabled, promptBiometric } from "@/utils/biometric";
import { apiRequest } from "@/utils/api";

function InfoRow({ label, value, icon }: { label: string; value?: string | number | null; icon: string }) {
  const colors = useColors();
  if (value === null || value === undefined || value === "") return null;
  return (
    <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
      <Feather name={icon as any} size={14} color={colors.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: colors.foreground }]}>{String(value)}</Text>
      </View>
    </View>
  );
}

async function openOwnedDoc(path: string) {
  try {
    const { url } = await apiRequest(`/me/storage/sign?path=${encodeURIComponent(path)}`);
    const can = await Linking.canOpenURL(url);
    if (can) {
      await Linking.openURL(url);
    } else {
      Alert.alert("Cannot open file", "No app on this device can open the file.");
    }
  } catch (e) {
    Alert.alert("Could not open file", (e as Error).message ?? "Unknown error");
  }
}

function DocRow({ label, path, icon = "file-text" }: { label: string; path?: string | null; icon?: string }) {
  const colors = useColors();
  if (!path) return null;
  return (
    <TouchableOpacity onPress={() => openOwnedDoc(path)} style={[styles.docRow, { borderBottomColor: colors.border }]}>
      <Feather name={icon as any} size={16} color={colors.primary} />
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{label}</Text>
      <Feather name="external-link" size={14} color={colors.mutedForeground} />
    </TouchableOpacity>
  );
}

function PhotoPreview({ path }: { path?: string | null }) {
  const colors = useColors();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!path) return;
    (async () => {
      try {
        const { url } = await apiRequest(`/me/storage/sign?path=${encodeURIComponent(path)}`);
        if (!cancelled) setUrl(url);
      } catch {
        // ignore — user can still see the doc link below
      }
    })();
    return () => { cancelled = true; };
  }, [path]);
  if (!path) return null;
  return (
    <View style={[styles.photoCard, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
      {url ? (
        <Image source={{ uri: url }} style={styles.photoImg} resizeMode="cover" />
      ) : (
        <View style={[styles.photoImg, { alignItems: "center", justifyContent: "center" }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}
    </View>
  );
}

type TrainingCert = {
  id: string;
  type: string;
  title: string;
  issuingAuthority?: string | null;
  certificateNumber?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  docKey?: string | null;
  status: "valid" | "expiring_soon" | "expired" | "no_expiry";
};

function MyTrainingSection() {
  const colors = useColors();
  const router = useRouter();
  const [items, setItems] = useState<TrainingCert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiRequest("/me/trainings");
        if (!cancelled) setItems(data);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const statusColor = (s: TrainingCert["status"]) => {
    if (s === "expired") return "#a33";
    if (s === "expiring_soon") return "#c9a84c";
    if (s === "no_expiry") return colors.mutedForeground;
    return "#3a8a3a";
  };
  const statusLabel = (s: TrainingCert["status"], d?: string | null) => {
    if (s === "expired") return `Expired ${d ?? ""}`.trim();
    if (s === "expiring_soon") return `Expires ${d}`;
    if (s === "no_expiry") return "No expiry";
    return `Valid · ${d}`;
  };
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>MY TRAINING ({items?.length ?? 0})</Text>
        <TouchableOpacity onPress={() => router.push("/training-add" as any)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Feather name="plus" size={14} color={colors.primary} />
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}>Add</Text>
        </TouchableOpacity>
      </View>
      {err && <Text style={[styles.emptyText, { color: "#a33" }]}>{err}</Text>}
      {!err && items === null ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
      ) : items && items.length === 0 ? (
        <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No training certificates on record. Tap “Add” to upload one.</Text>
      ) : (
        items?.map((c) => (
          <View key={c.id} style={[styles.licCard, { borderBottomColor: colors.border }]}>
            <View style={styles.licHeader}>
              <Text style={[styles.licType, { color: colors.foreground }]}>{c.title}</Text>
              <View style={[styles.badge, { backgroundColor: statusColor(c.status) + "20", borderColor: statusColor(c.status) }]}>
                <Text style={[styles.badgeText, { color: statusColor(c.status) }]}>{statusLabel(c.status, c.expiryDate)}</Text>
              </View>
            </View>
            <Text style={[styles.licNum, { color: colors.mutedForeground }]}>
              {c.type}{c.certificateNumber ? ` · #${c.certificateNumber}` : ""}{c.issuingAuthority ? ` · ${c.issuingAuthority}` : ""}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

export default function EmployeeProfileScreen() {
  const colors = useColors();
  const router = useRouter();
  const { logout } = useAuth();
  const topPad = Platform.OS === "web" ? 67 : 0;
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const a = await isBiometricAvailable();
      const e = await isBiometricEnabled();
      if (!cancelled) { setBioAvailable(a); setBioOn(e); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function toggleBio(next: boolean) {
    setBioBusy(true);
    try {
      if (next) {
        const ok = await promptBiometric("Confirm biometric to enable faster sign-in");
        if (!ok) { setBioBusy(false); return; }
      }
      await setBiometricEnabled(next);
      setBioOn(next);
    } finally {
      setBioBusy(false);
    }
  }

  const { data: me } = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  const userId = (me as any)?.id as string | undefined;
  const { data: profile, isLoading } = useGetEmployee(userId!, {
    query: { queryKey: getGetEmployeeQueryKey(userId!), enabled: !!userId },
  });
  const p = profile as any;
  const maxLevel = p?.maxLicenseLevel as number | null | undefined;

  const { data: licenses } = useGetLicenses({
    params: { employeeId: userId },
    query: { queryKey: getGetLicensesQueryKey({ employeeId: userId }), enabled: !!userId },
  } as any);

  const getLicenseStatus = (expiryDate: string) => {
    const expiry = new Date(expiryDate);
    const now = new Date();
    if (expiry < now) return { color: colors.destructive, label: "EXPIRED" };
    if (expiry <= new Date(now.getTime() + 30 * 86400000)) return { color: colors.accent, label: "EXPIRING" };
    return { color: "#22c55e", label: "VALID" };
  };

  if (isLoading) return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /></View>;

  const refs = Array.isArray(p?.references) ? (p.references as any[]) : [];
  const certs = Array.isArray(p?.trainingCertificateKeys) ? (p.trainingCertificateKeys as string[]) : [];
  const acks = p?.acknowledgements && typeof p.acknowledgements === "object"
    ? (Array.isArray(p.acknowledgements) ? p.acknowledgements : Object.values(p.acknowledgements))
    : [];
  const availabilitySlots = Array.isArray(p?.availability)
    ? (p.availability as any[])
    : (p?.availability && typeof p.availability === "object" ? Object.entries(p.availability).map(([day, period]) => ({ day, period })) : []);
  const mailtoCorrection = `mailto:hr@williamscouncilsecurity.com?subject=${encodeURIComponent("Profile correction request")}&body=${encodeURIComponent(`Hi HR,\n\nPlease update the following on my profile:\n\n[describe what needs to change]\n\nThanks,\n${p?.firstName ?? ""} ${p?.lastName ?? ""}`)}`;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 100 }}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>My Profile</Text>
        <TouchableOpacity onPress={logout} style={[styles.logoutBtn, { borderColor: colors.destructive + "50" }]}>
          <Feather name="log-out" size={16} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.heroRow}>
          <Image source={require("@/assets/images/logo.png")} style={styles.brandLogo} resizeMode="contain" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.heroName, { color: colors.foreground }]}>{p?.firstName} {p?.lastName}</Text>
            <View style={[styles.roleBadge, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "50" }]}>
              <Text style={[styles.roleText, { color: colors.primary }]}>SECURITY OFFICER</Text>
            </View>
          </View>
        </View>
        {p?.hourlyRate && (
          <View style={[styles.rateBar, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Feather name="dollar-sign" size={14} color={colors.accent} />
            <Text style={[styles.rateText, { color: colors.accent }]}>${parseFloat(p.hourlyRate as any).toFixed(2)}/hr</Text>
          </View>
        )}
        <View style={[styles.levelBar, { backgroundColor: levelColor(maxLevel, colors) + "15", borderColor: levelColor(maxLevel, colors) + "60" }]}>
          <Feather name="award" size={16} color={levelColor(maxLevel, colors)} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.mutedForeground, fontSize: 10, fontWeight: "700", letterSpacing: 1 }}>HIGHEST CURRENT CLEARANCE</Text>
            <Text style={{ color: levelColor(maxLevel, colors), fontSize: 16, fontWeight: "700", marginTop: 2 }}>
              {levelLabel(maxLevel ?? null)}
            </Text>
          </View>
        </View>
      </View>

      {p?.photoKey && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>PHOTO ON FILE</Text>
          <PhotoPreview path={p.photoKey} />
        </View>
      )}

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>CONTACT</Text>
        <InfoRow label="Email" value={p?.email} icon="mail" />
        <InfoRow label="Phone" value={p?.phone} icon="phone" />
        <InfoRow label="Address" value={p?.address} icon="map-pin" />
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>PERSONAL DETAILS</Text>
        <InfoRow label="Date of birth" value={p?.dateOfBirth} icon="calendar" />
        <InfoRow label="City of birth" value={p?.cityOfBirth} icon="map" />
        <InfoRow label="State of birth" value={p?.stateOfBirth} icon="map" />
        <InfoRow label="SSN (last 4)" value={p?.niNumber ? `••• •• ${String(p.niNumber).slice(-4)}` : null} icon="hash" />
        <InfoRow label="Right to work" value={p?.rightToWorkStatus} icon="check-circle" />
        {!p?.dateOfBirth && !p?.niNumber && !p?.rightToWorkStatus && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No personal details on file.</Text>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>EMERGENCY CONTACT</Text>
        <InfoRow label="Name" value={p?.emergencyContactName} icon="user" />
        <InfoRow label="Relationship" value={p?.emergencyContactRelationship} icon="users" />
        <InfoRow label="Phone" value={p?.emergencyContactPhone} icon="phone" />
        {!p?.emergencyContactName && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No emergency contact on file. Please update below.</Text>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>TX SECURITY LICENSE</Text>
        <InfoRow label="License number" value={p?.siaLicenseNumber} icon="credit-card" />
        <InfoRow label="Level" value={p?.siaLicenseLevel ? `L${p.siaLicenseLevel}` : null} icon="shield" />
        <InfoRow label="Expires" value={p?.siaLicenseExpiry} icon="calendar" />
        {!p?.siaLicenseNumber && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No TX license on file.</Text>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>UNIFORM SIZES</Text>
        <InfoRow label="Shirt" value={p?.uniformShirt} icon="user" />
        <InfoRow label="Trousers" value={p?.uniformTrousers} icon="user" />
        <InfoRow label="Jacket" value={p?.uniformJacket} icon="user" />
        <InfoRow label="Boots" value={p?.uniformBoots} icon="user" />
        {!p?.uniformShirt && !p?.uniformTrousers && !p?.uniformJacket && !p?.uniformBoots && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No uniform sizes on file.</Text>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>BANKING & TAX</Text>
        <InfoRow label="Account name" value={p?.bankAccountName} icon="user" />
        <InfoRow label="Account number" value={p?.bankAccountNumber ? `••••${String(p.bankAccountNumber).slice(-4)}` : null} icon="credit-card" />
        <InfoRow label="Routing / sort code" value={p?.bankBsb} icon="hash" />
        <InfoRow label="Tax code" value={p?.taxCode} icon="file-text" />
        <InfoRow label="Direct deposit consent" value={p?.directDepositConsent ? "Yes" : (p?.directDepositConsent === false ? "No" : null)} icon="check" />
        {!p?.bankAccountNumber && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No banking details on file.</Text>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>EXPERIENCE</Text>
        <InfoRow label="Years" value={p?.yearsExperience} icon="briefcase" />
        {p?.previousExperience ? (
          <View style={[styles.infoRow, { borderBottomColor: colors.border, alignItems: "flex-start" }]}>
            <Feather name="file-text" size={14} color={colors.mutedForeground} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>Previous experience</Text>
              <Text style={[styles.infoValue, { color: colors.foreground }]}>{p.previousExperience}</Text>
            </View>
          </View>
        ) : null}
        {!p?.yearsExperience && !p?.previousExperience && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No experience on file.</Text>
        )}
      </View>

      {refs.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>REFERENCES</Text>
          {refs.map((r, i) => (
            <View key={i} style={[styles.refRow, { borderBottomColor: colors.border }]}>
              <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 14 }}>{r?.name ?? "—"}</Text>
              {r?.relationship ? <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{r.relationship}</Text> : null}
              {r?.phone ? <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{r.phone}</Text> : null}
              {r?.email ? <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{r.email}</Text> : null}
            </View>
          ))}
        </View>
      )}

      {availabilitySlots.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>AVAILABILITY</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground, fontStyle: "normal" }]}>
            {availabilitySlots.length} slot{availabilitySlots.length === 1 ? "" : "s"} on file.
          </Text>
          <View style={styles.skillsWrap}>
            {availabilitySlots.slice(0, 14).map((s, i) => (
              <View key={i} style={[styles.skillChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                <Text style={[styles.skillText, { color: colors.foreground }]}>{(s?.day ?? "")} {(s?.period ?? "")}</Text>
              </View>
            ))}
            {availabilitySlots.length > 14 && (
              <Text style={[styles.skillText, { color: colors.mutedForeground }]}>+{availabilitySlots.length - 14} more</Text>
            )}
          </View>
        </View>
      )}

      {(p?.skills?.length ?? 0) > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>SKILLS & QUALIFICATIONS</Text>
          <View style={styles.skillsWrap}>
            {p.skills!.map((s: string) => (
              <View key={s} style={[styles.skillChip, { backgroundColor: colors.primary + "20", borderColor: colors.primary + "40" }]}>
                <Text style={[styles.skillText, { color: colors.primary }]}>{s}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>DOCUMENTS</Text>
        <DocRow label="Photo" path={p?.photoKey} icon="image" />
        <DocRow label="CV / résumé" path={p?.cvKey} icon="file-text" />
        <DocRow label="TX security license" path={p?.licenseDocKey} icon="credit-card" />
        <DocRow label="Passport / photo ID" path={p?.passportDocKey} icon="book" />
        <DocRow label="Right-to-work doc" path={p?.rightToWorkDocKey} icon="check-circle" />
        <DocRow label="W-2 / pay stub" path={p?.payStubDocKey} icon="dollar-sign" />
        {certs.map((k, i) => (
          <DocRow key={k + i} label={`Training certificate ${i + 1}`} path={k} icon="award" />
        ))}
        {!p?.photoKey && !p?.cvKey && !p?.licenseDocKey && !p?.passportDocKey && !p?.rightToWorkDocKey && !p?.payStubDocKey && certs.length === 0 && (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No documents on file.</Text>
        )}
      </View>

      {acks.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.accent }]}>ACKNOWLEDGEMENTS</Text>
          {acks.map((a: any, i: number) => (
            <View key={i} style={[styles.infoRow, { borderBottomColor: colors.border }]}>
              <Feather name={a?.accepted ? "check-circle" : "x-circle"} size={14} color={a?.accepted ? "#22c55e" : colors.destructive} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{a?.type ?? "Acknowledgement"}</Text>
                {a?.signature ? (
                  <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>
                    Signed “{a.signature}”{a?.timestamp ? ` · ${new Date(a.timestamp).toLocaleDateString()}` : ""}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}

      <MyTrainingSection />

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>MY LICENCES ({licenses?.length ?? 0})</Text>
        {(licenses?.length ?? 0) === 0 ? (
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No licences on record</Text>
        ) : licenses!.map((lic: any) => {
          const ls = getLicenseStatus(lic.expiryDate);
          return (
            <View key={lic.id} style={[styles.licCard, { borderBottomColor: colors.border }]}>
              <View style={styles.licHeader}>
                <Text style={[styles.licType, { color: colors.foreground }]}>{lic.type}</Text>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {lic.level != null && <LicenseLevelBadge level={lic.level} size="sm" />}
                  <View style={[styles.badge, { backgroundColor: ls.color + "20", borderColor: ls.color }]}>
                    <Text style={[styles.badgeText, { color: ls.color }]}>{ls.label}</Text>
                  </View>
                </View>
              </View>
              <Text style={[styles.licNum, { color: colors.mutedForeground }]}>{lic.licenseNumber}</Text>
              <Text style={[styles.licExpiry, { color: ls.color, fontWeight: "600" }]}>Expires {lic.expiryDate}</Text>
            </View>
          );
        })}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>ACCOUNT</Text>
        <TouchableOpacity
          onPress={() => router.push("/edit-profile" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="edit-3" size={16} color={colors.primary} />
          <Text style={{ color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600" }}>Edit profile</Text>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => Linking.openURL(mailtoCorrection).catch(() => Alert.alert("Email unavailable", "Could not open your email app. Please contact HR directly."))}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="alert-circle" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Request a correction</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              Email HR to fix anything you can't edit yourself
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/paystubs" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="dollar-sign" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>My paystubs</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              View pay history and year-to-date totals
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/swap-requests" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="repeat" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Shift swaps</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              See and respond to swap requests
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/dar" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="clipboard" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Daily activity report</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              File or review your end-of-shift summaries
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/patrol" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="map-pin" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Patrol scan</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              Scan checkpoint codes during rounds
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/availability" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="calendar" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>My availability</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              Weekly hours + matching open shifts
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/license-renewal" as any)}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="credit-card" size={16} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>License renewals</Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
              Submit a renewed license for admin approval
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push({ pathname: "/change-password" as any, params: { mode: "self" } })}
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
        >
          <Feather name="lock" size={16} color={colors.primary} />
          <Text style={{ color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600" }}>Change password</Text>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        {bioAvailable && (
          <View style={[styles.actionRow, { borderBottomColor: "transparent" }]}>
            <Feather name="smile" size={16} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>
                {Platform.OS === "ios" ? "Face ID / Touch ID unlock" : "Fingerprint unlock"}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
                {bioOn ? "Enabled" : "Disabled"}
              </Text>
            </View>
            <Switch value={bioOn} onValueChange={toggleBio} disabled={bioBusy} />
          </View>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.accent }]}>WILLIAMS COUNCIL SECURITY GROUP</Text>
        <View style={styles.companyRow}>
          <Feather name="shield" size={14} color={colors.mutedForeground} />
          <Text style={[styles.companyText, { color: colors.mutedForeground }]}>Protection With Passion</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  logoutBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  logoutText: { fontSize: 13, fontWeight: "600" },
  heroCard: { margin: 16, padding: 18, borderRadius: 14, borderWidth: 1, gap: 12 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  brandLogo: { width: 60, height: 60, borderRadius: 30 },
  heroName: { fontSize: 20, fontWeight: "700" },
  roleBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6, borderWidth: 1, alignSelf: "flex-start" },
  roleText: { fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  rateBar: { flexDirection: "row", alignItems: "center", gap: 6, padding: 10, borderRadius: 8, borderWidth: 1 },
  levelBar: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 8, borderWidth: 1 },
  rateText: { fontSize: 15, fontWeight: "700" },
  section: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, borderWidth: 1, padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderBottomWidth: 1 },
  infoLabel: { fontSize: 11, marginBottom: 2 },
  infoValue: { fontSize: 14 },
  skillsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  skillChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  skillText: { fontSize: 13 },
  licCard: { paddingVertical: 12, borderBottomWidth: 1, gap: 3 },
  licHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  licType: { fontSize: 14, fontWeight: "600", flex: 1 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700" },
  licNum: { fontSize: 12 },
  licExpiry: { fontSize: 12 },
  emptyText: { fontSize: 13, fontStyle: "italic" },
  companyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  companyText: { fontSize: 13 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: 1 },
  docRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  refRow: { paddingVertical: 10, borderBottomWidth: 1, gap: 2 },
  photoCard: { borderWidth: 1, borderRadius: 10, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  photoImg: { width: "100%", height: 220 },
});
