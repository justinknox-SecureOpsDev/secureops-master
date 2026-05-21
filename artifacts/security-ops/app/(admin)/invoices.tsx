import React, { useState, useMemo } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { useColors } from "@/hooks/useColors";
import {
  useGetInvoices, getGetInvoicesQueryKey,
  useGenerateInvoice, useUpdateInvoice,
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

const FILTERS = ["draft", "sent", "paid", "overdue"] as const;

export default function AdminInvoicesScreen() {
  const colors = useColors();
  const router = useRouter();
  const queryClient = useQueryClient();
  const topPad = useTopPad();

  const [filter, setFilter] = useState<typeof FILTERS[number]>("draft");
  const [siteId, setSiteId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string>(getISOWeekStart(new Date()));

  const { data: clients } = useGetClients({ query: { queryKey: getGetClientsQueryKey() } });
  const { data: sites } = useGetSites({}, { query: { queryKey: getGetSitesQueryKey({}) } });

  const { data: invoices, isLoading, refetch } = useGetInvoices(
    { siteId: siteId || undefined, status: filter } as any,
    { query: { queryKey: getGetInvoicesQueryKey({ siteId: siteId || undefined, status: filter } as any) } },
  );

  const generate = useGenerateInvoice();
  const updateInv = useUpdateInvoice();

  const totalAmt = useMemo(() => (invoices ?? []).reduce((s: number, i: any) => s + parseFloat(i.totalAmount ?? "0"), 0), [invoices]);

  const shiftWeek = (delta: number) => {
    const d = new Date(weekStart + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta * 7);
    setWeekStart(getISOWeekStart(d));
  };

  const runGenerate = () => {
    if (!siteId) { Alert.alert("Pick Site", "Choose a site to invoice."); return; }
    generate.mutateAsync({ data: { siteId, weekStart } } as any).then((inv: any) => {
      queryClient.invalidateQueries({ queryKey: getGetInvoicesQueryKey({}) });
      Alert.alert("Invoice Generated", `${inv?.invoiceNumber ?? "Invoice"} · $${parseFloat(inv?.totalAmount ?? "0").toFixed(2)}`);
    }).catch((e: any) => Alert.alert("Failed", e?.response?.data?.message || e?.message || "Generation failed"));
  };

  const setStatus = (item: any, next: string) => {
    Alert.alert("Confirm", `Mark ${item.invoiceNumber} as ${next}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm", onPress: async () => {
          await updateInv.mutateAsync({
            id: item.id,
            data: { status: next, paidAt: next === "paid" ? new Date().toISOString() : null } as any,
          });
          queryClient.invalidateQueries({ queryKey: getGetInvoicesQueryKey({}) });
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
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Invoices</Text>
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
              {new Date(weekStart + "T00:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}
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
              <Feather name="file-plus" size={14} color={colors.primaryForeground} />
              <Text style={{ color: colors.primaryForeground, fontWeight: "700" }}>Generate Invoice for Week</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)}
            style={[styles.chip, { borderColor: filter === f ? colors.primary : colors.border, backgroundColor: filter === f ? colors.primary + "20" : "transparent" }]}>
            <Text style={[styles.chipTxt, { color: filter === f ? colors.primary : colors.mutedForeground }]}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1, alignItems: "flex-end" }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>${totalAmt.toFixed(2)}</Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : (
        <FlatList
          data={(invoices ?? []) as any[]}
          keyExtractor={(i: any) => i.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          refreshing={false}
          onRefresh={refetch}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="file-text" size={40} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, marginTop: 12 }}>No {filter} invoices for this site/week.</Text>
            </View>
          }
          renderItem={({ item }: { item: any }) => {
            const sMap: Record<string, string> = { draft: colors.mutedForeground, sent: colors.primary, paid: "#22c55e", overdue: colors.destructive };
            const c = sMap[item.status] || colors.mutedForeground;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: c + "60" }]}>
                <View style={styles.cardHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: colors.foreground }]}>{item.invoiceNumber}</Text>
                    <Text style={[styles.sub, { color: colors.primary }]}>{item.clientName} · {item.siteName ?? "—"}</Text>
                    <Text style={[styles.sub, { color: colors.mutedForeground }]}>{item.periodStart} → {item.periodEnd}</Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: c + "20", borderColor: c }]}>
                    <Text style={{ color: c, fontWeight: "700", fontSize: 11 }}>{item.status.toUpperCase()}</Text>
                  </View>
                </View>

                <View style={[styles.grid, { borderTopColor: colors.border, borderBottomColor: colors.border }]}>
                  <View style={styles.gItem}><Text style={[styles.gv, { color: colors.foreground }]}>${parseFloat(item.subtotal).toFixed(2)}</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Subtotal</Text></View>
                  <View style={[styles.gDiv, { backgroundColor: colors.border }]} />
                  <View style={styles.gItem}><Text style={[styles.gv, { color: colors.mutedForeground }]}>${parseFloat(item.taxAmount ?? "0").toFixed(2)}</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Tax</Text></View>
                  <View style={[styles.gDiv, { backgroundColor: colors.border }]} />
                  <View style={styles.gItem}><Text style={[styles.gv, { color: colors.accent }]}>${parseFloat(item.totalAmount).toFixed(2)}</Text><Text style={[styles.gl, { color: colors.mutedForeground }]}>Total</Text></View>
                </View>

                <View style={styles.dateRow}>
                  <Feather name="calendar" size={12} color={colors.mutedForeground} />
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                    Created {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "—"}
                  </Text>
                  <Feather name="clock" size={12} color={item.status === "overdue" ? colors.destructive : colors.mutedForeground} style={{ marginLeft: 8 }} />
                  <Text style={{ color: item.status === "overdue" ? colors.destructive : colors.mutedForeground, fontSize: 12 }}>
                    Due {item.dueDate ? new Date(item.dueDate).toLocaleDateString([], { timeZone: "UTC" }) : "—"}
                  </Text>
                </View>

                <View style={{ flexDirection: "row", gap: 8 }}>
                  {item.status === "draft" && (
                    <TouchableOpacity onPress={() => setStatus(item, "sent")} style={[styles.act, { borderColor: colors.primary }]}>
                      <Feather name="send" size={13} color={colors.primary} /><Text style={{ color: colors.primary, fontWeight: "700", fontSize: 13 }}>Mark Sent</Text>
                    </TouchableOpacity>
                  )}
                  {(item.status === "sent" || item.status === "overdue" || item.status === "draft") && (
                    <TouchableOpacity onPress={() => setStatus(item, "paid")} style={[styles.act, { borderColor: "#22c55e" }]}>
                      <Feather name="check-circle" size={13} color="#22c55e" /><Text style={{ color: "#22c55e", fontWeight: "700", fontSize: 13 }}>Mark Paid</Text>
                    </TouchableOpacity>
                  )}
                  {item.status === "paid" && (
                    <TouchableOpacity onPress={() => setStatus(item, "sent")} style={[styles.act, { borderColor: colors.mutedForeground }]}>
                      <Feather name="rotate-ccw" size={13} color={colors.mutedForeground} /><Text style={{ color: colors.mutedForeground, fontWeight: "700", fontSize: 13 }}>Mark Unpaid</Text>
                    </TouchableOpacity>
                  )}
                </View>
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
  filterRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8, alignItems: "center", flexWrap: "wrap" },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  name: { fontSize: 15, fontWeight: "700" },
  sub: { fontSize: 12, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  grid: { flexDirection: "row", paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1 },
  gItem: { flex: 1, alignItems: "center" },
  gv: { fontSize: 16, fontWeight: "700" },
  gl: { fontSize: 10, marginTop: 2 },
  gDiv: { width: 1, marginVertical: 4 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  act: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderRadius: 8, borderWidth: 1 },
});
