import React, { useState, useMemo, useLayoutEffect } from "react";
import { useNavigation } from "expo-router";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Alert, Platform, Switch, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useCreateShift, getGetShiftsQueryKey,
  useGetClients, getGetClientsQueryKey,
  useGetSites, getGetSitesQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";

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
        accessibilityLabel={`${label}${required ? ", required" : ""}`}
      />
    </View>
  );
}

const LEVELS: Array<{ value: 1 | 2 | 3 | 4; label: string; sub: string }> = [
  { value: 1, label: "Support", sub: "No license required — open to any worker" },
  { value: 2, label: "Level 2", sub: "Unarmed — any qualified officer" },
  { value: 3, label: "Level 3", sub: "Armed — L3 or L4 officers only" },
  { value: 4, label: "L4 / PPO", sub: "Personal Protection — L4 only" },
];

export default function CreateShiftScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const createShift = useCreateShift();
  const topPad = useTopPad();
  const { user } = useAuth();
  // Site Managers never set rates — the server inherits them from the site default.
  const isSiteManager = user?.role === "site_manager";
  const navigation = useNavigation();
  useLayoutEffect(() => { (navigation as any).setOptions?.({ headerShown: false }); }, [navigation]);

  const { data: clients } = useGetClients({ query: { queryKey: getGetClientsQueryKey() } });

  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  const endTime = new Date(nextHour);
  endTime.setHours(endTime.getHours() + 8);
  const fmt = (d: Date) => d.toISOString().slice(0, 16);

  const [form, setForm] = useState({
    title: "",
    clientId: "",
    siteId: "",
    notes: "",
    startTime: fmt(nextHour),
    endTime: fmt(endTime),
    payRate: "",
    billRate: "",
    isRepeat: false,
    repeatPattern: "",
    requiredLicenseLevel: 2 as 1 | 2 | 3 | 4,
    headcount: "1",
  });
  const set = (key: string) => (val: any) => setForm((f) => ({ ...f, [key]: val }));

  const { data: sites } = useGetSites({ clientId: form.clientId || undefined } as any, {
    query: { queryKey: getGetSitesQueryKey({ clientId: form.clientId || undefined } as any), enabled: !!form.clientId },
  });

  const selectedSite = useMemo(() => (sites ?? []).find((s: any) => s.id === form.siteId), [sites, form.siteId]);

  const handleCreate = async () => {
    const ratesRequired = !isSiteManager;
    if (!form.title || !form.siteId || !form.startTime || !form.endTime || (ratesRequired && (!form.payRate || !form.billRate))) {
      Alert.alert("Missing Fields", ratesRequired ? "Title, site, times, pay rate and bill rate are required." : "Title, site and times are required.");
      return;
    }
    try {
      await createShift.mutateAsync({
        data: {
          title: form.title,
          siteId: form.siteId,
          notes: form.notes || undefined,
          startTime: new Date(form.startTime).toISOString(),
          endTime: new Date(form.endTime).toISOString(),
          // Site Managers omit rates entirely; the server resolves them from the site default.
          ...(isSiteManager ? {} : { payRate: parseFloat(form.payRate), billRate: parseFloat(form.billRate) }),
          isRepeat: form.isRepeat,
          repeatPattern: form.isRepeat ? (form.repeatPattern as any) || undefined : undefined,
          requiredLicenseLevel: form.requiredLicenseLevel,
          headcount: Math.max(1, parseInt(form.headcount) || 1),
        } as any,
      });
      queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() });
      Alert.alert("Shift Posted", "All qualified officers have been notified.");
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.message || e?.message || "Failed to create shift");
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">Post New Shift</Text>
      </View>

      <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        <Text style={[styles.sectionLabel, { color: colors.accent }]}>SHIFT DETAILS</Text>
        <Field label="Shift Title (assignment name)" value={form.title} onChangeText={set("title")} placeholder="Kanvas L3" required />

        <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 4 }]}>Client *</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(clients ?? []).length === 0 && (
              <TouchableOpacity onPress={() => router.push("/(admin)/clients" as any)}
                style={[styles.pickChip, { borderColor: colors.accent, borderStyle: "dashed" }]}
                accessibilityRole="button" accessibilityLabel="Add a client">
                <Feather name="plus" size={14} color={colors.accent} />
                <Text style={{ color: colors.accent, fontWeight: "600" }}>Add a client</Text>
              </TouchableOpacity>
            )}
            {((clients as any[]) ?? []).map((c) => {
              const sel = c.id === form.clientId;
              return (
                <TouchableOpacity key={c.id} onPress={() => { setForm((f) => ({ ...f, clientId: c.id, siteId: "" })); }}
                  style={[styles.pickChip, { borderColor: sel ? colors.primary : colors.border, backgroundColor: sel ? colors.primary + "20" : colors.card }]}
                  accessibilityRole="button" accessibilityState={{ selected: sel }} accessibilityLabel={`Client ${c.name}`}>
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
                {((sites as any[]) ?? []).length === 0 && (
                  <TouchableOpacity onPress={() => router.push(`/(admin)/clients/${form.clientId}` as any)}
                    style={[styles.pickChip, { borderColor: colors.accent, borderStyle: "dashed" }]}
                    accessibilityRole="button" accessibilityLabel="Add a site">
                    <Feather name="plus" size={14} color={colors.accent} />
                    <Text style={{ color: colors.accent, fontWeight: "600" }}>Add a site</Text>
                  </TouchableOpacity>
                )}
                {((sites as any[]) ?? []).map((s) => {
                  const sel = s.id === form.siteId;
                  return (
                    <TouchableOpacity key={s.id} onPress={() => set("siteId")(s.id)}
                      style={[styles.pickChip, { borderColor: sel ? colors.primary : colors.border, backgroundColor: sel ? colors.primary + "20" : colors.card }]}
                      accessibilityRole="button" accessibilityState={{ selected: sel }} accessibilityLabel={`Site ${s.name}`}>
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

        <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>LICENSE REQUIREMENT *</Text>
        <View style={{ gap: 8, marginBottom: 14 }}>
          {LEVELS.map((opt) => {
            const selected = form.requiredLicenseLevel === opt.value;
            return (
              <TouchableOpacity key={opt.value} onPress={() => set("requiredLicenseLevel")(opt.value)}
                style={[styles.levelOpt, {
                  backgroundColor: selected ? colors.primary + "20" : colors.card,
                  borderColor: selected ? colors.primary : colors.border,
                }]}
                accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${opt.label}. ${opt.sub}`}>
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
            thumbColor={form.isRepeat ? colors.primary : colors.mutedForeground}
            accessibilityLabel="Repeating shift" accessibilityRole="switch" accessibilityState={{ checked: form.isRepeat }} />
        </View>
        {form.isRepeat && (
          <Field label="Repeat Pattern" value={form.repeatPattern} onChangeText={set("repeatPattern")} placeholder="weekly" autoCapitalize="none" />
        )}

        {!isSiteManager && (
          <>
            <Text style={[styles.sectionLabel, { color: colors.accent, marginTop: 20 }]}>RATES (this site / assignment)</Text>
            <Field label="Officer Pay Rate ($/hr)" value={form.payRate} onChangeText={set("payRate")} placeholder="18.00" keyboardType="decimal-pad" autoCapitalize="none" required />
            <Field label="Client Bill Rate ($/hr)" value={form.billRate} onChangeText={set("billRate")} placeholder="30.00" keyboardType="decimal-pad" autoCapitalize="none" required />
          </>
        )}

        <View style={[styles.broadcastNote, { backgroundColor: colors.accent + "15", borderColor: colors.accent + "50" }]}>
          <Feather name="bell" size={14} color={colors.accent} />
          <Text style={[styles.broadcastText, { color: colors.accent }]}>
            All qualifying officers (Level {form.requiredLicenseLevel}{form.requiredLicenseLevel < 4 ? "+" : ""}) will be notified. They reserve a slot, then must explicitly accept.
          </Text>
        </View>

        <TouchableOpacity style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: createShift.isPending ? 0.7 : 1 }]}
          onPress={handleCreate} disabled={createShift.isPending}
          accessibilityRole="button" accessibilityLabel="Post shift" accessibilityState={{ disabled: createShift.isPending, busy: createShift.isPending }}>
          {createShift.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <>
              <Feather name="send" size={18} color={colors.primaryForeground} />
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Post Shift</Text>
            </>
          )}
        </TouchableOpacity>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  levelOpt: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 10, borderWidth: 1.5 },
  levelDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  levelLabel: { fontSize: 15, fontWeight: "700" },
  levelSub: { fontSize: 12, marginTop: 2 },
  broadcastNote: { flexDirection: "row", gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, marginTop: 12, alignItems: "flex-start" },
  broadcastText: { flex: 1, fontSize: 12, lineHeight: 17 },
});
