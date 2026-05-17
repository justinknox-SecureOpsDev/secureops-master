import React, { useState, useMemo, useEffect, useLayoutEffect } from "react";
import { useNavigation } from "expo-router";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert, Platform, Switch, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useGetShift, getGetShiftQueryKey,
  useUpdateShift, useDeleteShift, getGetShiftsQueryKey,
  useGetClients, getGetClientsQueryKey,
  useGetSites, getGetSitesQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { confirmAction } from "@/utils/confirm";

function Field({ label, value, onChangeText, placeholder, keyboardType, autoCapitalize, required }: any) {
  const colors = useColors();
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}{required ? " *" : ""}</Text>
      <TextInput
        style={[styles.fieldInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.secondary }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType || "default"}
        autoCapitalize={autoCapitalize || "sentences"}
      />
    </View>
  );
}

const LEVELS: Array<{ value: 2 | 3 | 4; label: string; sub: string }> = [
  { value: 2, label: "Level 2", sub: "Unarmed — any qualified officer" },
  { value: 3, label: "Level 3", sub: "Armed — L3 or L4 officers only" },
  { value: 4, label: "L4 / PPO", sub: "Personal Protection — L4 only" },
];

const STATUSES: Array<"upcoming" | "active" | "completed" | "cancelled"> = ["upcoming", "active", "completed", "cancelled"];

/** Format a Date / ISO string as the local-time "YYYY-MM-DDTHH:mm" the form
 *  expects. Mirrors the create screen's input format so admins see the same
 *  values they originally entered, not a UTC-shifted version. */
function fmtLocal(input?: string | null): string {
  if (!input) return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EditShiftScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const topPad = useTopPad();
  const navigation = useNavigation();
  useLayoutEffect(() => { (navigation as any).setOptions?.({ headerShown: false }); }, [navigation]);

  const { data: shift, isLoading, error, refetch } = useGetShift(id!, {
    query: { queryKey: getGetShiftQueryKey(id!), enabled: !!id, retry: 1 },
  });
  const updateShift = useUpdateShift();
  const deleteShift = useDeleteShift();
  const { data: clients } = useGetClients({ query: { queryKey: getGetClientsQueryKey() } });
  // Unfiltered sites: lets us derive the shift's clientId from its siteId,
  // since the shift row only stores siteId (no clientId column).
  const { data: allSites } = useGetSites({} as any, {
    query: { queryKey: getGetSitesQueryKey({} as any) },
  });

  const [form, setForm] = useState({
    title: "",
    clientId: "",
    siteId: "",
    notes: "",
    startTime: "",
    endTime: "",
    payRate: "",
    billRate: "",
    isRepeat: false,
    repeatPattern: "",
    requiredLicenseLevel: 2 as 2 | 3 | 4,
    headcount: "1",
    status: "upcoming" as "upcoming" | "active" | "completed" | "cancelled",
  });
  const set = (key: string) => (val: any) => setForm((f) => ({ ...f, [key]: val }));

  // Prefill once the shift loads AND we know the site→client mapping. The
  // shift row only stores siteId, so we resolve clientId via the sites list.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!shift || hydrated) return;
    const siteId = (shift as any).siteId ?? "";
    const matchedSite = siteId ? ((allSites as any[]) ?? []).find((s) => s.id === siteId) : undefined;
    if (siteId && !matchedSite) return; // wait for sites to load before hydrating
    setForm((f) => ({
      ...f,
      title: shift.title ?? "",
      siteId,
      clientId: matchedSite?.clientId ?? "",
      notes: shift.notes ?? "",
      startTime: fmtLocal(shift.startTime),
      endTime: fmtLocal(shift.endTime),
      payRate: String((shift as any).payRate ?? (shift as any).hourlyRate ?? ""),
      billRate: String((shift as any).billRate ?? ""),
      isRepeat: !!shift.isRepeat,
      repeatPattern: typeof shift.repeatPattern === "string" ? shift.repeatPattern : (shift.repeatPattern ? JSON.stringify(shift.repeatPattern) : ""),
      requiredLicenseLevel: ((shift as any).requiredLicenseLevel ?? 2) as 2 | 3 | 4,
      headcount: String((shift as any).headcount ?? 1),
      status: (shift.status as any) ?? "upcoming",
    }));
    setHydrated(true);
  }, [shift, hydrated]);

  const { data: sites } = useGetSites({ clientId: form.clientId || undefined } as any, {
    query: { queryKey: getGetSitesQueryKey({ clientId: form.clientId || undefined } as any), enabled: !!form.clientId },
  });

  const selectedSite = useMemo(
    () => ((sites ?? (allSites ?? [])) as any[]).find((s: any) => s.id === form.siteId),
    [sites, allSites, form.siteId],
  );

  const handleSave = async () => {
    if (!form.title || !form.siteId || !form.startTime || !form.endTime || !form.payRate || !form.billRate) {
      Alert.alert("Missing Fields", "Title, site, times, pay rate and bill rate are required.");
      return;
    }
    try {
      await updateShift.mutateAsync({
        id: id!,
        data: {
          title: form.title,
          siteId: form.siteId,
          notes: form.notes || undefined,
          startTime: new Date(form.startTime).toISOString(),
          endTime: new Date(form.endTime).toISOString(),
          payRate: parseFloat(form.payRate),
          billRate: parseFloat(form.billRate),
          isRepeat: form.isRepeat,
          repeatPattern: form.isRepeat ? (form.repeatPattern as any) || undefined : undefined,
          requiredLicenseLevel: form.requiredLicenseLevel,
          headcount: Math.max(1, parseInt(form.headcount) || 1),
          status: form.status,
        } as any,
      });
      queryClient.invalidateQueries({ queryKey: getGetShiftQueryKey(id!) });
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
      Alert.alert("Saved", "Shift updated.");
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.message || e?.message || "Failed to update shift");
    }
  };

  const handleDelete = async () => {
    const ok = await confirmAction({
      title: "Delete Shift",
      message: "This permanently removes the shift and all assignments. Continue?",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteShift.mutateAsync({ id: id! });
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
      Alert.alert("Deleted", "Shift removed.");
      // Pop the edit screen and the now-stale detail screen.
      router.back();
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.message || e?.message || "Failed to delete shift");
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  if (!shift) {
    const msg = !id
      ? "No shift was selected. Go back and tap a shift to edit it."
      : (error as any)?.response?.data?.message
        || (error as any)?.message
        || "We couldn't load that shift. It may have been deleted, or your session may have expired.";
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: 24, gap: 16 }]}>
        <Feather name="alert-triangle" size={36} color={colors.destructive} />
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", textAlign: "center" }}>Couldn't load shift</Text>
        <Text style={{ color: colors.mutedForeground, fontSize: 14, textAlign: "center" }}>{msg}</Text>
        <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
          <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border, paddingHorizontal: 16 }]}>
            <Text style={{ color: colors.foreground, fontWeight: "600" }}>Back</Text>
          </TouchableOpacity>
          {id && (
            <TouchableOpacity onPress={() => refetch()} style={[styles.submitBtn, { backgroundColor: colors.primary, paddingHorizontal: 20, marginTop: 0 }]}>
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Edit Shift</Text>
      </View>

      <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        <Text style={[styles.sectionLabel, { color: colors.accent }]}>SHIFT DETAILS</Text>
        <Field label="Shift Title (assignment name)" value={form.title} onChangeText={set("title")} placeholder="Kanvas L3" required />

        <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 4 }]}>Client *</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {((clients as any[]) ?? []).map((c) => {
              const sel = c.id === form.clientId;
              return (
                <TouchableOpacity key={c.id} onPress={() => { setForm((f) => ({ ...f, clientId: c.id, siteId: f.clientId === c.id ? f.siteId : "" })); }}
                  style={[styles.pickChip, { borderColor: sel ? colors.primary : colors.border, backgroundColor: sel ? colors.primary + "20" : colors.card }]}>
                  <Text style={{ color: sel ? colors.primary : colors.foreground, fontWeight: "600" }}>{c.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        {form.clientId !== "" && (
          <>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Site *</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {((sites as any[]) ?? []).map((s) => {
                  const sel = s.id === form.siteId;
                  return (
                    <TouchableOpacity key={s.id} onPress={() => set("siteId")(s.id)}
                      style={[styles.pickChip, { borderColor: sel ? colors.primary : colors.border, backgroundColor: sel ? colors.primary + "20" : colors.card }]}>
                      <Feather name="map-pin" size={12} color={sel ? colors.primary : colors.mutedForeground} />
                      <Text style={{ color: sel ? colors.primary : colors.foreground, fontWeight: "600" }}>{s.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </>
        )}

        {selectedSite && (selectedSite as any).address && (
          <View style={[styles.helper, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Feather name="map-pin" size={12} color={colors.mutedForeground} />
            <Text style={{ color: colors.mutedForeground, fontSize: 12, flex: 1 }}>{(selectedSite as any).address}</Text>
          </View>
        )}

        <Field label="Notes" value={form.notes} onChangeText={set("notes")} placeholder="Bring high-vis vest" />

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>STATUS</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {STATUSES.map((s) => {
              const sel = form.status === s;
              return (
                <TouchableOpacity key={s} onPress={() => set("status")(s)}
                  style={[styles.pickChip, { borderColor: sel ? colors.primary : colors.border, backgroundColor: sel ? colors.primary + "20" : colors.card }]}>
                  <Text style={{ color: sel ? colors.primary : colors.foreground, fontWeight: "600", textTransform: "capitalize" }}>{s}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 8 }]}>LICENCE REQUIREMENT *</Text>
        <View style={{ gap: 8, marginBottom: 14 }}>
          {LEVELS.map((opt) => {
            const selected = form.requiredLicenseLevel === opt.value;
            return (
              <TouchableOpacity key={opt.value} onPress={() => set("requiredLicenseLevel")(opt.value)}
                style={[styles.levelOpt, {
                  backgroundColor: selected ? colors.primary + "20" : colors.card,
                  borderColor: selected ? colors.primary : colors.border,
                }]}>
                <View style={[styles.levelDot, { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primary : "transparent" }]}>
                  {selected && <Feather name="check" size={12} color={colors.primaryForeground} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.levelLabel, { color: selected ? colors.primary : colors.foreground }]}>{opt.label}</Text>
                  <Text style={[styles.levelSub, { color: colors.mutedForeground }]}>{opt.sub}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <Field label="Number of Officers Needed" value={form.headcount} onChangeText={set("headcount")} placeholder="1" keyboardType="numeric" autoCapitalize="none" required />

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>SCHEDULE</Text>
        <Field label="Start Time (YYYY-MM-DDTHH:MM)" value={form.startTime} onChangeText={set("startTime")} placeholder="2026-06-01T20:00" autoCapitalize="none" required />
        <Field label="End Time (YYYY-MM-DDTHH:MM)" value={form.endTime} onChangeText={set("endTime")} placeholder="2026-06-02T04:00" autoCapitalize="none" required />

        <View style={[styles.switchRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="repeat" size={16} color={colors.mutedForeground} />
          <Text style={[styles.switchLabel, { color: colors.foreground }]}>Repeating Shift</Text>
          <Switch value={form.isRepeat} onValueChange={set("isRepeat")}
            trackColor={{ false: colors.border, true: colors.primary + "80" }}
            thumbColor={form.isRepeat ? colors.primary : colors.mutedForeground} />
        </View>
        {form.isRepeat && (
          <Field label="Repeat Pattern" value={form.repeatPattern} onChangeText={set("repeatPattern")} placeholder="weekly" autoCapitalize="none" />
        )}

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>RATES</Text>
        <Field label="Officer Pay Rate ($/hr)" value={form.payRate} onChangeText={set("payRate")} placeholder="18.00" keyboardType="decimal-pad" autoCapitalize="none" required />
        <Field label="Client Bill Rate ($/hr)" value={form.billRate} onChangeText={set("billRate")} placeholder="30.00" keyboardType="decimal-pad" autoCapitalize="none" required />

        <TouchableOpacity style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: updateShift.isPending ? 0.7 : 1 }]}
          onPress={handleSave} disabled={updateShift.isPending}>
          {updateShift.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <>
              <Feather name="save" size={18} color={colors.primaryForeground} />
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Save Changes</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={[styles.deleteBtn, { borderColor: colors.destructive, opacity: deleteShift.isPending ? 0.5 : 1 }]}
          onPress={handleDelete} disabled={deleteShift.isPending}>
          <Feather name="trash-2" size={16} color={colors.destructive} />
          <Text style={[styles.deleteText, { color: colors.destructive }]}>Delete Shift</Text>
        </TouchableOpacity>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 2, marginBottom: 12 },
  fieldWrap: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, marginBottom: 6, fontWeight: "500" },
  fieldInput: { height: 46, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, fontSize: 15 },
  pickChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderWidth: 1 },
  helper: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderRadius: 6, borderWidth: 1, marginBottom: 14 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 8, borderWidth: 1, marginBottom: 14 },
  switchLabel: { flex: 1, fontSize: 14 },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, padding: 16, borderRadius: 12, marginTop: 12 },
  submitText: { fontSize: 16, fontWeight: "700" },
  deleteBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, borderRadius: 12, marginTop: 12, borderWidth: 1.5 },
  deleteText: { fontSize: 14, fontWeight: "700" },
  levelOpt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 10, borderWidth: 1.5 },
  levelDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  levelLabel: { fontSize: 15, fontWeight: "700" },
  levelSub: { fontSize: 12, marginTop: 2 },
});
