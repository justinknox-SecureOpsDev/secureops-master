import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Alert, Platform,
} from "react-native";
import { useRouter, Stack } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useTopPad } from "@/hooks/useTopPad";
import { apiRequest } from "@/utils/api";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

type ListResponse = { notifications: NotificationRow[]; unreadCount: number };

function iconFor(type: string): { name: any; color: string } {
  switch (type) {
    case "chat_message": return { name: "message-circle", color: "#3b82f6" };
    case "emergency": return { name: "alert-octagon", color: "#ef4444" };
    case "geofence_breach":
    case "geofence": return { name: "navigation", color: "#f97316" };
    case "shift_assignment":
    case "shift_vacancy":
    case "shift_reminder": return { name: "calendar", color: "#c9a84c" };
    case "license_expiry":
    case "license": return { name: "id-card", color: "#f59e0b" };
    case "shift_swap": return { name: "repeat", color: "#a855f7" };
    case "application":
    case "onboarding": return { name: "user-plus", color: "#22c55e" };
    default: return { name: "bell", color: "#94a3b8" };
  }
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export default function NotificationsScreen() {
  const colors = useColors();
  const router = useRouter();
  const topPad = useTopPad();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const r = (await apiRequest("/me/notifications")) as ListResponse;
      setData(r);
    } catch (e) {
      setError((e as Error).message ?? "Could not load notifications");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Mark everything read as soon as the screen mounts — the user is
  // actively viewing the inbox, so the home-screen badge should clear,
  // and the per-row "unread" dot should disappear immediately.
  useEffect(() => {
    if (!data || data.unreadCount === 0) return;
    const nowIso = new Date().toISOString();
    setData((prev) => prev ? {
      unreadCount: 0,
      notifications: prev.notifications.map((n) => n.readAt ? n : { ...n, readAt: nowIso }),
    } : prev);
    void apiRequest("/me/notifications/mark-read", {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => {});
  }, [data?.unreadCount]);

  const handleTap = useCallback((n: NotificationRow) => {
    const type = n.type;
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (type === "chat_message" && typeof d.roomId === "string") {
      router.push(`/(employee)/chat` as any);
      return;
    }
    if (type === "emergency" || type === "incident") {
      router.push("/(employee)/incidents" as any);
      return;
    }
    if (type.startsWith("shift") || type === "shift_assignment" || type === "shift_vacancy") {
      router.push("/(employee)/shifts" as any);
      return;
    }
    if (type === "license_expiry" || type === "license") {
      router.push("/license-renewal" as any);
    }
  }, [router]);

  const handleClearAll = useCallback(() => {
    if (!data || data.notifications.length === 0) return;
    const doClear = async () => {
      setBusy(true);
      try {
        await apiRequest("/me/notifications", {
          method: "DELETE",
          body: JSON.stringify({}),
        });
        setData({ notifications: [], unreadCount: 0 });
      } catch (e) {
        setError((e as Error).message ?? "Could not clear notifications");
      } finally {
        setBusy(false);
      }
    };
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm("Clear all notifications? This can't be undone.")) {
        void doClear();
      }
      return;
    }
    Alert.alert(
      "Clear notifications?",
      "This removes every notification from your history. It can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear all", style: "destructive", onPress: () => void doClear() },
      ],
    );
  }, [data]);

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
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Feather name="chevron-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>Notifications</Text>
          <TouchableOpacity
            onPress={handleClearAll}
            style={styles.backBtn}
            disabled={busy || !data || data.notifications.length === 0}
          >
            <Feather
              name="trash-2"
              size={18}
              color={!data || data.notifications.length === 0 ? colors.mutedForeground + "60" : colors.mutedForeground}
            />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
        ) : error ? (
          <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.destructive, fontSize: 14 }}>{error}</Text>
          </View>
        ) : !data || data.notifications.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="bell-off" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No notifications</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              You'll see shift assignments, vacancies, chat messages, license reminders, and emergency alerts here.
            </Text>
          </View>
        ) : (
          data.notifications.map((n) => {
            const { name, color } = iconFor(n.type);
            const unread = !n.readAt;
            return (
              <TouchableOpacity
                key={n.id}
                activeOpacity={0.8}
                onPress={() => handleTap(n)}
                style={[
                  styles.row,
                  {
                    backgroundColor: unread ? colors.primary + "12" : colors.card,
                    borderColor: unread ? colors.primary + "40" : colors.border,
                  },
                ]}
              >
                <View style={[styles.iconWrap, { backgroundColor: color + "20" }]}>
                  <Feather name={name} size={18} color={color} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.rowHead}>
                    <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>
                      {n.title}
                    </Text>
                    {unread && <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />}
                  </View>
                  <Text style={[styles.rowBody, { color: colors.mutedForeground }]} numberOfLines={3}>
                    {n.body}
                  </Text>
                  <Text style={[styles.rowWhen, { color: colors.mutedForeground }]}>
                    {fmtWhen(n.createdAt)}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  topBar: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 12,
    borderBottomWidth: 1, justifyContent: "space-between",
  },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700" },
  empty: { margin: 16, padding: 24, borderRadius: 12, borderWidth: 1, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "700", marginTop: 8 },
  emptyText: { fontSize: 13, textAlign: "center", lineHeight: 18 },
  row: {
    flexDirection: "row", gap: 12, padding: 14, marginHorizontal: 12, marginTop: 8,
    borderRadius: 12, borderWidth: 1, alignItems: "flex-start",
  },
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontSize: 14, fontWeight: "700", flex: 1 },
  rowBody: { fontSize: 13, lineHeight: 18 },
  rowWhen: { fontSize: 11, marginTop: 4 },
  unreadDot: { width: 8, height: 8, borderRadius: 4 },
});
