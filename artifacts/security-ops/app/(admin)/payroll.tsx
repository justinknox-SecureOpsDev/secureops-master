import React, { useState, useMemo } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useGetPayrollEntries, getGetPayrollEntriesQueryKey,
  useGeneratePayroll,
  useUpdatePayrollEntry,
  useGetSites, getGetSitesQueryKey,
  useGetClients, getGetClientsQueryKey,
} from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

function getISOWeekStart(d: Date): string {
  const day = d.getUTCDay();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - ((day + 6) % 7));
  return m.toISOString().slice(0, 10);
}

const STATUS_FILTERS = ["pending", "paid"] as const;

export default function AdminPayrollScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();

  const [filter, setFilter] = useState<typeof STATUS_FILTERS[number]>("pending");
  const [siteId, setSiteId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string>(getISOWeekStart(new Date()));

  const { data: clients } = useGetClients({ query: { queryKey: getGetClientsQueryKey() } });
  const { data: sites } = useGetSites({}, { query: { queryKey: getGetSitesQueryKey({}) } });

  const { data: payroll, isLoading, refetch } = useGetPayrollEntries(
    { siteId: siteId || undefined, status: filter } as any,
    { query: { queryKey: getGetPayrollEntriesQueryKey({ siteId: siteId || undefined, status: filter } as any) } },
  );

  const generate = useGeneratePayroll();
  const updateEntry = useUpdatePayrollEntry();

  const totalGross = useMemo(() => (payroll ?? []).reduce((s: number, p: any) => s + parseFloat(p.grossPay ?? "0"), 0), [payroll]);
  const totalNet = useMemo(() => (payroll ?? []).reduce((s: number, p: any) => s + parseFloat(p.netPay ?? "0"), 0), [payroll]);

  const shiftWeek = (delta: number) => {
    const d = new Date(weekStart + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta * 7);
    setWeekStart(getISOWeekStart(d));
  };

  const runGenerate = () => {
    if (!siteId) { Alert.alert("Pick Site", "Choose a site to generate payroll for."); return; }
    generate.mutateAsync({ data: { siteId, weekStart } } as any).then((rows: any) => {
      queryClient.invalidateQueries({ queryKey: getGetPayrollEntriesQueryKey({}) });
      Alert.alert("Payroll Generated", `${(rows ?? []).length} entr${(rows ?? []).length === 1 ? "y" : "ies"} for week of ${weekStart}.`);
    }).catch((e: any) => Alert.alert("Failed", e?.response?.data?.message || e?.message || "Generation failed"));
  };

  const togglePaid = (item: any) => {
    const next = item.status === "paid" ? "pending" : "paid";
    Alert.alert("Confirm", `Mark $${parseFloat(item.netPay).toFixed(2)} for ${item.employeeName} as ${next}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm", onPress: async () => {
          await updateEntry.mutateAsync({ id: item.id, data: { status: next, paidAt: next === "paid" ? new Date().toISOString() : null } as any });
          queryClient.invalidateQueries({ queryKey: getGetPayrollEntriesQueryKey({}) });
        }
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { borderColor: colors.border }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Payroll</Text>
      </View>

      <View style={[styles.controls, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.controlLabel, { color: colors.mutedForeground }]}>SITE</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <TouchableOpacity onPress={() => setSiteId("")}
              style={[styles.chip, { borderColor: !siteId ? colors.primary : colors.border, backgroundColor: !siteId ? colors.primary + "20" : "transparent" }]}>
              <Text style={[styles.chipTxt, { color: !siteId ? colors.primary : colors.mutedForeground }]}>All Sites</Text>
            </TouchableOpacity>
            {((sites as any[]) ?? []).map((s) => {
              const sel = s.id === siteId;
              const clientName = ((clients as any[]) ?? []).find((c) => c.id === s.clientId)?.name;
              return (
                <TouchableOpacity key={s.id} onPress={() => setSiteId(s.id)}
                  style={[styles.chip, { borderColor: sel ? colors.primary : colors.border, backgroundColor: sel ? colors.primary + "20" : "transparent" }]}>
                  <Text style={[styles.chipTxt, { color: sel ? colors.primary : colors.foreground }]}>
                    {s.name}{clientName ? ` · ${clientName}` : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        <View style={styles.weekRow}>
          <TouchableOpacity onPress={() => shiftWeek(-1)} style={[styles.weekBtn, { borderColor: colors.border }]}>
            <Feather name="chevron-left" size={16} color={colors.foreground} />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={[styles.controlLabel, { color: colors.mutedForeground }]}>WEEK STARTING</Text>
            <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 14 }}>
              {new Date(weekStart + "T00:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            </Text>
          </View>
          <TouchableOpacity onPress={() => shiftWeek(1)} style={[styles.weekBtn, { borderColor: colors.border }]}>
            <Feather name="chevron-right" size={16} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={runGenerate} disabled={generate.isPending}
          style={[styles.genBtn, { backgroundColor: colors.primary, opacity: generate.isPending ? 0.6 : 1 }]}>
          {generate.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <>
              <Feather name="zap" size={14} color={colors.primaryForeground} />
              <Text style={{ color: colors.primaryForeground, fontWeight: "700" }}>Generate from Approved Hours</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)}
            style={[styles.chip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}>
            <Text style={[styles.chipTxt, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1, alignItems: "flex-end" }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>Gross ${totalGross.toFixed(2)} · Net ${totalNet.toFixed(2)}</Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <FlatList
          data={(payroll ?? []) as any[]}
          keyExtractor={(p: any) => p.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          refreshing={false}
          onRefresh={refetch}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="dollar-sign" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No {filter} entries for this site/week.</Text>
            </View>
          }
          renderItem={({ item }: { item: any }) => {
            const isPaid = item.status === "paid";
            const c = isPaid ? "#22c55e" : colors.accent;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: colors.foreground }]}>{item.employeeName}</Text>
                    <Text style={[styles.sub, { color: colors.mutedForeground }]}>
                      {item.siteName ?? "—"} · {item.periodStart} → {item.periodEnd}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
                    <Text style={{ color: c, fontWeight: "700", fontSize: 11 }}>{item.status.toUpperCase()}</Text>
                  </View>
                </View>
                <View style={[styles.grid, { borderTopColor: colors.border }]}>
                  <View style={styles.gItem}><Text style={[styles.gv, { color: colors.foreground }]}>{parseFloat(item.totalHours).toFixed(2)}h</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Hours</Text></View>
                  <View style={[styles.gDiv, { backgroundColor: colors.border }]} />
                  <View style={styles.gItem}><Text style={[styles.gv, { color: colors.foreground }]}>${parseFloat(item.hourlyRate).toFixed(2)}</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Rate</Text></View>
                  <View style={[styles.gDiv, { backgroundColor: colors.border }]} />
                  <View style={styles.gItem}><Text style={[styles.gv, { color: colors.primary }]}>${parseFloat(item.grossPay).toFixed(2)}</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Gross</Text></View>
                  <View style={[styles.gDiv, { backgroundColor: colors.border }]} />
                  <View style={styles.gItem}><Text style={[styles.gv, { color: "#22c55e" }]}>${parseFloat(item.netPay).toFixed(2)}</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Net</Text></View>
                </View>
                <TouchableOpacity onPress={() => togglePaid(item)}
                  style={[styles.toggle, { borderColor: isPaid ? colors.mutedForeground : "#22c55e" }]}>
                  <Feather name={isPaid ? "rotate-ccw" : "check-circle"} size={14} color={isPaid ? colors.mutedForeground : "#22c55e"} />
                  <Text style={{ color: isPaid ? colors.mutedForeground : "#22c55e", fontWeight: "700", fontSize: 13 }}>
                    {isPaid ? "Mark Pending" : "Mark Paid"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  backBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  pageTitle: { fontSize: 22, fontWeight: "700" },
  controls: { margin: 16, marginBottom: 4, padding: 12, borderRadius: 12, borderWidth: 1, gap: 10 },
  controlLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1.2 },
  weekRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  weekBtn: { padding: 8, borderRadius: 8, borderWidth: 1 },
  genBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 12, borderRadius: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
  chipTxt: { fontSize: 12, fontWeight: "600" },
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8, alignItems: "center" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 14, fontWeight: "700" },
  sub: { fontSize: 12, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  grid: { flexDirection: "row", paddingTop: 12, borderTopWidth: 1 },
  gItem: { flex: 1, alignItems: "center" },
  gv: { fontSize: 15, fontWeight: "700" },
  gl: { fontSize: 10, marginTop: 2 },
  gDiv: { width: 1, marginVertical: 4 },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderRadius: 8, borderWidth: 1 },
});
