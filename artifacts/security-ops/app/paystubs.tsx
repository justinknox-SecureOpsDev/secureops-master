import React, { useEffect, useState, useCallback } from "react";
import { useTopPad } from "@/hooks/useTopPad";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Platform, RefreshControl,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";

type PaystubRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  totalHours: string;
  hourlyRate: string;
  grossPay: string;
  tax: string;
  netPay: string;
  status: "pending" | "processed" | "paid" | "failed";
  paidAt: string | null;
  paidMethod: string | null;
  paymentReference: string | null;
  siteName: string | null;
};

type PaystubsResponse = {
  rows: PaystubRow[];
  summary: { ytdGross: string; ytdNet: string; lifetimeNet: string; count: number };
};

const STATUS_LABEL: Record<PaystubRow["status"], string> = {
  pending: "Pending",
  processed: "Processing",
  paid: "Paid",
  failed: "Failed",
};

function statusColor(s: PaystubRow["status"], colors: ReturnType<typeof useColors>): string {
  if (s === "paid") return "#22c55e";
  if (s === "failed") return colors.destructive;
  if (s === "processed") return colors.accent;
  return colors.mutedForeground;
}

function fmtUsd(n: string | number): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "$0.00";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtRange(a: string, b: string): string {
  const d1 = new Date(a + "T00:00:00");
  const d2 = new Date(b + "T00:00:00");
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const yr = d2.getFullYear();
  return `${d1.toLocaleDateString("en-US", opts)} – ${d2.toLocaleDateString("en-US", opts)}, ${yr}`;
}

export default function PaystubsScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const [data, setData] = useState<PaystubsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const r = await apiRequest("/me/payroll");
      setData(r as PaystubsResponse);
    } catch (e) {
      setError((e as Error).message ?? "Could not load paystubs");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        style={[styles.container, { backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={colors.primary}
          />
        }
      >
        <View style={[styles.topBar, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Feather name="chevron-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.pageTitle, { color: colors.foreground }]} accessibilityRole="header">My Paystubs</Text>
          <View style={{ width: 32 }} />
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
        ) : error ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.destructive, fontSize: 14 }}>{error}</Text>
          </View>
        ) : !data || data.rows.length === 0 ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, alignItems: "center" }]}>
            <Feather name="inbox" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No paystubs yet</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Once your hours are approved and a pay run is generated, your paystubs will appear here.
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.summaryRow}>
                <View style={styles.summaryCell}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>YTD GROSS</Text>
                  <Text style={[styles.summaryValue, { color: colors.foreground }]}>{fmtUsd(data.summary.ytdGross)}</Text>
                </View>
                <View style={[styles.summaryCell, { borderLeftColor: colors.border, borderLeftWidth: 1 }]}>
                  <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>YTD NET</Text>
                  <Text style={[styles.summaryValue, { color: colors.accent }]}>{fmtUsd(data.summary.ytdNet)}</Text>
                </View>
              </View>
              <View style={[styles.summaryFoot, { borderTopColor: colors.border }]}>
                <Text style={[styles.summaryFootText, { color: colors.mutedForeground }]}>
                  {data.summary.count} paystub{data.summary.count === 1 ? "" : "s"} · Lifetime net {fmtUsd(data.summary.lifetimeNet)}
                </Text>
              </View>
            </View>

            {data.rows.map((row) => {
              const sc = statusColor(row.status, colors);
              const stubA11y = `Paystub ${fmtRange(row.periodStart, row.periodEnd)}${row.siteName ? `, ${row.siteName}` : ""}. ${STATUS_LABEL[row.status]}. ${Number(row.totalHours).toFixed(2)} hours at ${fmtUsd(row.hourlyRate)} per hour. Gross ${fmtUsd(row.grossPay)}, tax ${fmtUsd(row.tax)}, net pay ${fmtUsd(row.netPay)}.${row.status === "paid" && row.paidAt ? ` Paid ${new Date(row.paidAt).toLocaleDateString()}.` : ""}`;
              return (
                <View
                  key={row.id}
                  style={[styles.stub, { backgroundColor: colors.card, borderColor: colors.border }]}
                  accessible
                  accessibilityLabel={stubA11y}
                >
                  <View style={styles.stubHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.stubPeriod, { color: colors.foreground }]}>
                        {fmtRange(row.periodStart, row.periodEnd)}
                      </Text>
                      {row.siteName ? (
                        <Text style={[styles.stubSite, { color: colors.mutedForeground }]}>{row.siteName}</Text>
                      ) : null}
                    </View>
                    <View style={[styles.statusPill, { backgroundColor: sc + "20", borderColor: sc + "60" }]}>
                      <Text style={[styles.statusPillText, { color: sc }]}>{STATUS_LABEL[row.status]}</Text>
                    </View>
                  </View>

                  <View style={[styles.stubGrid, { borderTopColor: colors.border }]}>
                    <View style={styles.stubGridCell}>
                      <Text style={[styles.stubLabel, { color: colors.mutedForeground }]}>Hours</Text>
                      <Text style={[styles.stubValue, { color: colors.foreground }]}>{Number(row.totalHours).toFixed(2)}</Text>
                    </View>
                    <View style={styles.stubGridCell}>
                      <Text style={[styles.stubLabel, { color: colors.mutedForeground }]}>Rate</Text>
                      <Text style={[styles.stubValue, { color: colors.foreground }]}>{fmtUsd(row.hourlyRate)}/hr</Text>
                    </View>
                    <View style={styles.stubGridCell}>
                      <Text style={[styles.stubLabel, { color: colors.mutedForeground }]}>Gross</Text>
                      <Text style={[styles.stubValue, { color: colors.foreground }]}>{fmtUsd(row.grossPay)}</Text>
                    </View>
                    <View style={styles.stubGridCell}>
                      <Text style={[styles.stubLabel, { color: colors.mutedForeground }]}>Tax</Text>
                      <Text style={[styles.stubValue, { color: colors.foreground }]}>−{fmtUsd(row.tax)}</Text>
                    </View>
                  </View>

                  <View style={[styles.netRow, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                    <Text style={[styles.netLabel, { color: colors.mutedForeground }]}>NET PAY</Text>
                    <Text style={[styles.netValue, { color: colors.accent }]}>{fmtUsd(row.netPay)}</Text>
                  </View>

                  {row.status === "paid" && (
                    <View style={styles.paidLine}>
                      <Feather name="check-circle" size={12} color="#22c55e" />
                      <Text style={[styles.paidText, { color: colors.mutedForeground }]}>
                        Paid {row.paidAt ? new Date(row.paidAt).toLocaleDateString() : ""}
                        {row.paidMethod ? ` · ${row.paidMethod}` : ""}
                        {row.paymentReference ? ` · Ref ${row.paymentReference}` : ""}
                      </Text>
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, justifyContent: "space-between" },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  section: { margin: 16, padding: 18, borderRadius: 12, borderWidth: 1, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", marginTop: 12 },
  emptyText: { fontSize: 13, textAlign: "center", marginTop: 4, lineHeight: 18 },
  summaryCard: { margin: 16, marginBottom: 8, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  summaryRow: { flexDirection: "row" },
  summaryCell: { flex: 1, padding: 16, gap: 4 },
  summaryLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  summaryValue: { fontSize: 22, fontWeight: "700" },
  summaryFoot: { padding: 10, borderTopWidth: 1, alignItems: "center" },
  summaryFootText: { fontSize: 11 },
  stub: { marginHorizontal: 16, marginTop: 8, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  stubHead: { flexDirection: "row", alignItems: "center", padding: 14, gap: 10 },
  stubPeriod: { fontSize: 14, fontWeight: "700" },
  stubSite: { fontSize: 12, marginTop: 2 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  statusPillText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  stubGrid: { flexDirection: "row", flexWrap: "wrap", borderTopWidth: 1, padding: 8 },
  stubGridCell: { width: "50%", padding: 8, gap: 2 },
  stubLabel: { fontSize: 10, fontWeight: "600", letterSpacing: 0.5 },
  stubValue: { fontSize: 14, fontWeight: "600" },
  netRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", margin: 12, marginTop: 4, padding: 12, borderRadius: 8, borderWidth: 1 },
  netLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  netValue: { fontSize: 18, fontWeight: "700" },
  paidLine: { flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: 12, paddingBottom: 12 },
  paidText: { fontSize: 11 },
});
