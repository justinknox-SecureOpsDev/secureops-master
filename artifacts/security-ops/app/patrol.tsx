import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { apiRequest } from "@/utils/api";
import { notify } from "@/utils/confirm";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";

type Scan = {
  id: string;
  scannedAt: string;
  checkpointLabel: string | null;
  siteName: string | null;
};

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function PatrolScreen() {
  const colors = useColors();
  const router = useRouter();

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiRequest("/me/patrol/recent");
      setScans(Array.isArray(data?.scans) ? data.scans : []);
    } catch (e: any) {
      notify("Could not load scans", e?.message ?? "Please try again.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const trimmed = code.replace(/\s+/g, "").toUpperCase();
    if (!trimmed) {
      notify("Enter the code", "Type or paste the checkpoint code from the QR / NFC tag.");
      return;
    }
    setSubmitting(true);
    setLastResult(null);
    try {
      // Best-effort GPS — we don't block the scan on it.
      let lat: number | undefined; let lng: number | undefined;
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.granted) {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lat = pos.coords.latitude; lng = pos.coords.longitude;
        }
      } catch { /* ignore */ }

      const result: any = await apiRequest("/patrol/scan", {
        method: "POST",
        body: JSON.stringify({ code: trimmed, lat, lng }),
      });
      const label = result?.checkpoint?.label ?? "Checkpoint";
      const site = result?.checkpoint?.siteName ?? "site";
      let msg = `✓ Scanned ${label} at ${site}.`;
      if (result?.wrongSite) msg += " (Note: this checkpoint is not at your current shift's site.)";
      else if (!result?.onShift) msg += " (You're not currently clocked in.)";
      setLastResult(msg);
      setCode("");
      await load();
    } catch (e: any) {
      const msg = e?.message ?? "Could not record scan.";
      setLastResult(`✗ ${msg}`);
      notify("Scan failed", msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Patrol scan</Text>
        <View style={{ width: 30 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.accent} />}
      >
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
            Enter the code printed on the QR or NFC tag. Scanning a checkpoint
            logs your patrol so admins know your route was covered.
          </Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Checkpoint code (e.g. X7Q3K2HR9F)"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, marginTop: 10 }]}
            maxLength={32}
          />
          <TouchableOpacity
            onPress={submit}
            disabled={submitting}
            style={[styles.submitBtn, { backgroundColor: colors.accent, opacity: submitting ? 0.6 : 1 }]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={{ color: colors.primary, fontWeight: "700" }}>Log scan</Text>
            )}
          </TouchableOpacity>
          {lastResult && (
            <Text style={[styles.resultText, {
              color: lastResult.startsWith("✓") ? "#22c55e" : "#ef4444",
            }]}>
              {lastResult}
            </Text>
          )}
        </View>

        <Text style={[styles.sectionHeader, { color: colors.foreground }]}>Recent scans</Text>
        {scans === null ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />
        ) : scans.length === 0 ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
              No scans recorded yet. Your last 50 will show here.
            </Text>
          </View>
        ) : (
          scans.map((s) => (
            <View key={s.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, paddingVertical: 10 }]}>
              <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 14 }}>
                {s.checkpointLabel ?? "(removed checkpoint)"}
              </Text>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{s.siteName ?? "—"}</Text>
                <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{fmt(s.scannedAt)}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 16, fontWeight: "700" },
  helperText: { fontSize: 12, lineHeight: 16 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 12 },
  input: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 12 : 8, fontSize: 16, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  submitBtn: { height: 46, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 12 },
  resultText: { marginTop: 10, fontSize: 13, fontWeight: "600" },
  sectionHeader: { fontSize: 15, fontWeight: "700", marginTop: 24, marginBottom: 4 },
});
