import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, Platform, ActivityIndicator, TouchableOpacity, Linking, Animated, Pressable } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useGetActiveOfficers, getGetActiveOfficersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { handleMapMessage } from "@/components/liveOfficerMapHelpers";
import { Feather } from "@expo/vector-icons";
import LiveOfficerMap from "@/components/LiveOfficerMap";
import { formatDistanceToNow } from "date-fns";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { useHighlightFlash } from "@/hooks/useHighlightFlash";
import { FeatureGate } from "@/components/FeatureGate";
import { AUTH_TOKEN_KEY, useAuth } from "@/contexts/AuthContext";
import { storage } from "@/utils/storage";
import { apiRequest, getApiBaseUrl } from "@/utils/api";
import { createRadioMedia } from "@/components/radio/radioMedia";
import { createTransmitController, type TransmitController } from "@/components/radio/radioTransmit";
import type { RadioMedia, RadioToken } from "@/components/radio/radioTypes";

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

type SiteChannel = {
  id: string;
  name: string;
  scope: string;
  siteId: string | null;
  siteName?: string | null;
  adminOnly: boolean;
  archivedAt: string | null;
};

type Speaker = { userId: string; name: string } | null;
type TalkState = "idle" | "requesting" | "connecting" | "live";

function buildRadioWsUrl(token: string): string {
  const baseHttp = getApiBaseUrl().replace(/^http/, "ws").replace(/\/api$/, "");
  return `${baseHttp}/api/ws/radio?token=${encodeURIComponent(token)}`;
}

async function postRadioToken(
  path: string,
): Promise<{ status: number; data: RadioToken | null }> {
  const token = await storage.get(AUTH_TOKEN_KEY);
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return { status: res.status, data: null };
  return { status: res.status, data: (await res.json()) as RadioToken };
}

function isMicPermissionError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" || msg.includes("permission") || msg.includes("denied") || msg.includes("not allowed");
}

type SiteRadioState = { channelId: string; siteName: string } | null;

// ---------------------------------------------------------------------------
// SiteRadioPanel — a focused PTT panel for a single site radio channel.
// Opens a WS control-plane connection, joins the site's channel, and tears
// everything down on unmount (dismiss OR screen-blur via useFocusEffect above).
// ---------------------------------------------------------------------------
function SiteRadioPanel({
  channelId,
  siteName,
  onDismiss,
}: {
  channelId: string;
  siteName: string;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const { user } = useAuth();

  const [channel, setChannel] = useState<SiteChannel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [speaker, setSpeaker] = useState<Speaker>(null);
  const [talkState, setTalkState] = useState<TalkState>("idle");
  const [publishingChannelId, setPublishingChannelId] = useState<string | null>(null);
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRef = useRef<RadioMedia | null>(null);
  const joinedRef = useRef(false);
  const transmitRef = useRef<TransmitController | null>(null);
  const userIdRef = useRef<string | undefined>(user?.id);
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

  if (!transmitRef.current) {
    transmitRef.current = createTransmitController({
      send: (msg) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(msg));
        return true;
      },
      getUserId: () => userIdRef.current,
    });
  }

  // Fetch the channel record once on mount (to get its display name).
  // Since we already have the channelId from the map, we look it up by id directly.
  useEffect(() => {
    let cancelled = false;
    apiRequest("/radio/channels")
      .then((rows: SiteChannel[]) => {
        if (cancelled) return;
        const found = rows.find((c) => c.id === channelId && !c.archivedAt);
        if (found) {
          setChannel(found);
        } else {
          setLoadError("No active radio channel found.");
        }
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [channelId]);

  // Open WS once the channel is known. Tears down completely on unmount.
  useEffect(() => {
    if (!channel) return;
    const chId = channel.id;
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    mediaRef.current = createRadioMedia();

    const cancelTransmit = (): void => {
      transmitRef.current!.cancel();
      setTalkState("idle");
      setPublishingChannelId(null);
      void mediaRef.current?.stopPublish();
    };

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      setReconnecting(true);
      const base = Math.min(15_000, 1_000 * 2 ** attempt);
      const delay = base / 2 + Math.random() * (base / 2);
      attempt += 1;
      reconnectTimer = setTimeout(() => { void connect(); }, delay);
    };

    async function connect(): Promise<void> {
      if (cancelled) return;
      const token = await storage.get(AUTH_TOKEN_KEY);
      if (!token || cancelled) return;
      const ws = new WebSocket(buildRadioWsUrl(token));
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled || wsRef.current !== ws) return;
        attempt = 0;
        setWsReady(true);
        setReconnecting(false);
        setError(null);
        if (!joinedRef.current) {
          ws.send(JSON.stringify({ type: "join", channelId: chId }));
          joinedRef.current = true;
        }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        setWsReady(false);
        joinedRef.current = false;
        cancelTransmit();
        scheduleReconnect();
      };
      ws.onerror = () => { if (wsRef.current === ws) cancelTransmit(); };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        if (typeof ev.data !== "string") return;
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "speaking" && m.channelId === chId) {
            setSpeaker({ userId: m.speakerUserId, name: m.speakerName });
            const intent = transmitRef.current!.handleSpeaking(m.channelId, m.speakerUserId);
            if (intent) void beginPublish(intent.channelId, intent.gen);
          } else if (m.type === "silent" && m.channelId === chId) {
            setSpeaker(null);
          } else if (m.type === "denied") {
            const reason = m.reason;
            setError(
              reason === "busy" ? "Someone else is already transmitting." :
              reason === "preempted" ? "An admin took over the channel." :
              reason === "rate_limited" ? "Transmitting too quickly. Wait a moment." :
              reason === "forbidden" ? "Not allowed to transmit on this channel." :
              reason === "not_joined" ? "Not yet joined to channel." :
              `Transmission denied${reason ? ` (${reason})` : ""}.`,
            );
            cancelTransmit();
          }
        } catch { /* ignore */ }
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      // Send leave before closing so the server cleans up membership.
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "leave", channelId: chId })); } catch { /* ignore */ }
      }
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
      wsRef.current = null;
      joinedRef.current = false;
      mediaRef.current?.setOnListenLost(null);
      void mediaRef.current?.teardown();
      mediaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  async function beginPublish(chId: string, gen: number): Promise<void> {
    const aborted = (): boolean => transmitRef.current!.currentGen() !== gen;
    try {
      setTalkState("connecting");
      const { status, data } = await postRadioToken(`/radio/channels/${chId}/livekit-publish-token`);
      if (aborted()) return;
      if (!data) {
        if (status === 503) setAudioAvailable(false);
        throw new Error(status === 409 ? "Someone else is transmitting." : `Publish token failed (${status})`);
      }
      setPublishingChannelId(chId);
      await mediaRef.current!.startPublish(chId, data, aborted);
      if (aborted()) { await mediaRef.current?.stopPublish(); setPublishingChannelId(null); return; }
      setTalkState("live");
    } catch (e) {
      setError(isMicPermissionError(e)
        ? "Microphone access is off. Enable it for SecureOps in your device Settings, then try again."
        : `Could not start transmitting: ${(e as Error).message}`);
      setTalkState("idle");
      setPublishingChannelId(null);
      wsRef.current?.send(JSON.stringify({ type: "end", channelId: chId }));
    }
  }

  function startTalking(): void {
    if (!channel || talkState !== "idle") return;
    const supportsAudio = mediaRef.current?.supportsAudio ?? false;
    if (!supportsAudio) {
      setError("Live radio audio is in the SecureOps app on your phone.");
      return;
    }
    if (!audioAvailable) { setError("Live radio audio is not configured on this server."); return; }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setError(null);
    setTalkState("requesting");
    transmitRef.current!.start(channel.id);
  }

  async function stopTalking(): Promise<void> {
    if (!transmitRef.current!.intent()) return;
    transmitRef.current!.stop(publishingChannelId, channel?.id ?? null);
    setTalkState("idle");
    await mediaRef.current?.stopPublish();
    setPublishingChannelId(null);
  }

  const myUserId = user?.id;
  const isSpeakingMe = !!speaker && speaker.userId === myUserId;
  const otherSpeaker = speaker && speaker.userId !== myUserId ? speaker : null;
  const isTransmitting = talkState === "live" || talkState === "requesting" || talkState === "connecting";
  const supportsAudio = mediaRef.current?.supportsAudio ?? false;
  const pttDisabled = !!otherSpeaker || !wsReady || !channel || !supportsAudio || !audioAvailable;

  return (
    <View style={[panelStyles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Header */}
      <View style={panelStyles.header}>
        <Feather name="radio" size={16} color={colors.primary} />
        <Text style={[panelStyles.title, { color: colors.foreground }]} numberOfLines={1}>
          {channel?.name ?? siteName}
        </Text>
        <View style={[panelStyles.pill, { backgroundColor: wsReady ? "#16a34a22" : reconnecting ? "#f59e0b22" : "#71717a22" }]}>
          <Text style={{ color: wsReady ? "#16a34a" : reconnecting ? "#b45309" : colors.mutedForeground, fontSize: 10 }}>
            {wsReady ? "Live" : reconnecting ? "Reconnecting…" : "Connecting…"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Close site radio panel"
        >
          <Feather name="x" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      {loadError ? (
        <Text style={[panelStyles.errorText, { color: colors.destructive }]}>{loadError}</Text>
      ) : !channel ? (
        <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 8 }} />
      ) : (
        <>
          {error && (
            <Text style={[panelStyles.errorText, { color: colors.destructive }]}>{error}</Text>
          )}

          {/* Speaker status */}
          <View style={panelStyles.status}>
            {isSpeakingMe || isTransmitting ? (
              <View style={[panelStyles.banner, { backgroundColor: "#16a34a1a" }]}>
                <View style={[panelStyles.dot, { backgroundColor: "#16a34a" }]} />
                <Text style={{ color: "#15803d", fontSize: 12, fontWeight: "600" }}>
                  {talkState === "requesting" ? "Requesting floor…" : talkState === "connecting" ? "Connecting mic…" : "You are transmitting…"}
                </Text>
              </View>
            ) : otherSpeaker ? (
              <View style={[panelStyles.banner, { backgroundColor: "#0284c71a" }]}>
                <Feather name="volume-2" size={14} color="#0284c7" />
                <Text style={{ color: "#0369a1", fontSize: 12, fontWeight: "600" }}>{otherSpeaker.name} is transmitting…</Text>
              </View>
            ) : (
              <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>Channel idle</Text>
            )}
          </View>

          {/* PTT button */}
          <Pressable
            onPressIn={startTalking}
            onPressOut={() => { void stopTalking(); }}
            disabled={pttDisabled}
            accessibilityRole="button"
            accessibilityLabel={isTransmitting ? "Release to stop transmitting" : otherSpeaker ? "Channel busy" : "Hold to talk"}
            accessibilityHint="Press and hold to transmit on this channel"
            accessibilityState={{ disabled: pttDisabled, busy: isTransmitting }}
            style={({ pressed }) => [
              panelStyles.ptt,
              {
                backgroundColor: isTransmitting ? "#16a34a" : pttDisabled ? colors.muted : "#dc2626",
                opacity: (!isTransmitting && !pressed && pttDisabled) ? 0.45 : 1,
                transform: [{ scale: pressed && !pttDisabled ? 0.95 : 1 }],
              },
            ]}
          >
            <Feather
              name={isTransmitting ? "mic" : "mic-off"}
              size={20}
              color="#fff"
            />
            <Text style={panelStyles.pttLabel}>
              {isTransmitting ? "Transmitting…" : pttDisabled ? (otherSpeaker ? "Channel busy" : "Unavailable") : "Hold to Talk"}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const panelStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: "600" },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  errorText: { fontSize: 12 },
  status: { minHeight: 28, justifyContent: "center" },
  banner: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ptt: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 12, borderRadius: 10,
  },
  pttLabel: { color: "#fff", fontWeight: "700", fontSize: 14 },
});

// ---------------------------------------------------------------------------

export default function AdminLiveMapScreen() {
  return (
    <FeatureGate feature="liveMap">
      <AdminLiveMapScreenInner />
    </FeatureGate>
  );
}

function AdminLiveMapScreenInner() {
  const colors = useColors();
  const router = useRouter();
  const topPad = Platform.OS === "web" ? 12 : 0;
  const openOfficer = (userId: string) => router.push(`/(admin)/employees/${userId}` as any);

  const { data, isLoading, refetch, isFetching } = useGetActiveOfficers({
    query: {
      queryKey: getGetActiveOfficersQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const officers = (data ?? []) as any[];

  const queryClient = useQueryClient();

  // Listen on the main app WebSocket for liveOps:officerLeft pushes so a
  // just-clocked-out officer's marker disappears immediately instead of
  // lingering until the next 30s poll. Removal is done by filtering the
  // active-officers query cache in place; the next poll re-syncs with the
  // server as the source of truth.
  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const removeOfficer = (userId: string) => {
      queryClient.setQueryData(getGetActiveOfficersQueryKey(), (prev: unknown) =>
        Array.isArray(prev) ? prev.filter((o: any) => o?.userId !== userId) : prev,
      );
    };

    // A just-clocked-in officer: refetch the list rather than constructing
    // the row client-side — the server response carries site coords, shift
    // title, etc. that the WS event deliberately omits.
    const addOfficer = (_userId: string) => {
      void queryClient.invalidateQueries({ queryKey: getGetActiveOfficersQueryKey() });
    };

    async function connect(): Promise<void> {
      const token = await storage.get(AUTH_TOKEN_KEY);
      if (!token || cancelled) return;
      const base = getApiBaseUrl().replace(/\/api$/, "").replace(/^http(s?):\/\//, "ws$1://");
      const socket = new WebSocket(`${base}/api/ws?token=${encodeURIComponent(token)}`);
      ws = socket;
      socket.onmessage = (ev) => {
        if (ws !== socket || typeof ev.data !== "string") return;
        try {
          handleMapMessage(JSON.parse(ev.data), {
            onOfficerLeft: removeOfficer,
            onOfficerJoined: addOfficer,
          });
        } catch { /* ignore malformed frames */ }
      };
      socket.onclose = () => {
        if (cancelled || ws !== socket) return;
        reconnectTimer = setTimeout(() => { void connect(); }, 5000);
      };
      socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
    }

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      const socket = ws;
      ws = null;
      if (socket) { socket.onclose = null; try { socket.close(); } catch { /* ignore */ } }
    };
  }, [queryClient]);

  const { userId: focusUserParam, timeEntryId: focusTeParam, _hlTs } =
    useLocalSearchParams<{ userId?: string; timeEntryId?: string; _hlTs?: string }>();
  const focusUserId =
    focusUserParam ||
    (focusTeParam ? officers.find((o) => o.timeEntryId === focusTeParam)?.userId : undefined) ||
    undefined;
  const scrollRef = useRef<ScrollView>(null);
  const listY = useRef(0);
  const rowOffsets = useRef<Record<string, number>>({});
  const flashAnim = useHighlightFlash(focusUserId ? `${focusUserId}:${_hlTs ?? ""}` : null);

  // Site PTT panel state — null when closed, set when a site radio is opened
  // from the map (e.g. via a site marker's Radio button).
  const [siteRadio, setSiteRadio] = useState<SiteRadioState>(null);

  const handleOpenSiteRadio = useCallback((channelId: string, siteName: string) => {
    setSiteRadio({ channelId, siteName });
  }, []);

  useEffect(() => {
    if (!focusUserId) return;
    const t = setTimeout(() => {
      const rel = rowOffsets.current[focusUserId];
      if (rel == null) return;
      scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + rel - 24), animated: true });
    }, 400);
    return () => clearTimeout(t);
  }, [focusUserId, _hlTs, officers]);

  // Auto-dismiss the panel when the user navigates away from this tab so the
  // panel's WS connection is torn down (via the panel's unmount cleanup) and
  // the radio join is released. The panel's own onDismiss X-button also clears
  // this state via the same setter, keeping both paths consistent.
  useFocusEffect(
    useCallback(() => {
      return () => {
        setSiteRadio(null);
      };
    }, []),
  );

  return (
    <ScrollView ref={scrollRef} style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 120, paddingTop: topPad }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground }]}>Live Map</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {officers.length} officer{officers.length === 1 ? "" : "s"} currently on duty
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => refetch()}
          style={[styles.refresh, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Refresh officer list"
          accessibilityState={{ busy: isFetching }}
        >
          {isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="refresh-cw" size={16} color={colors.primary} />}
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <>
          <LiveOfficerMap
            officers={officers}
            height={380}
            onSelectOfficer={openOfficer}
            onOpenSiteRadio={handleOpenSiteRadio}
            focusUserId={focusUserId}
            focusKey={_hlTs}
          />

          {/* Site PTT panel — rendered when a site is selected from the map.
              Unmounts on dismiss OR when the screen loses focus (useFocusEffect
              above clears siteRadio, triggering unmount and WS teardown). */}
          {siteRadio && (
            <SiteRadioPanel
              key={siteRadio.channelId}
              channelId={siteRadio.channelId}
              siteName={siteRadio.siteName}
              onDismiss={() => setSiteRadio(null)}
            />
          )}

          <View
            style={styles.list}
            onLayout={(e) => { listY.current = e.nativeEvent.layout.y; }}
          >
            {officers.length === 0 ? (
              <View style={styles.emptyBox}>
                <Feather name="users" size={36} color={colors.mutedForeground} />
                <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                  No officers are currently clocked in.
                </Text>
              </View>
            ) : (
              officers.map((o: any) => {
                const lat = o.lastLat ?? o.clockInLat;
                const lng = o.lastLng ?? o.clockInLng;
                const ago = o.lastLocationAt
                  ? formatDistanceToNow(new Date(o.lastLocationAt), { addSuffix: true })
                  : "since clock-in";
                const isHighlighted = !!focusUserId && o.userId === focusUserId;
                return (
                  <AnimatedTouchable
                    key={o.timeEntryId}
                    onLayout={(e: any) => { rowOffsets.current[o.userId] = e.nativeEvent.layout.y; }}
                    onPress={() => openOfficer(o.userId)}
                    accessibilityRole="button"
                    accessibilityLabel={`View profile for ${o.firstName} ${o.lastName}`}
                    style={[styles.card, {
                      backgroundColor: isHighlighted
                        ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.card, colors.primary + "26"] })
                        : colors.card,
                      borderColor: isHighlighted
                        ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.border, colors.primary] })
                        : colors.border,
                      borderWidth: isHighlighted
                        ? flashAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2] })
                        : 1,
                    }]}
                  >
                    <View style={[styles.dot, { backgroundColor: "#22c55e" }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.name, { color: colors.foreground }]}>
                        {o.firstName} {o.lastName}
                      </Text>
                      <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {o.shiftTitle ? `${o.shiftTitle}` : "Shift"} {o.siteName ? `• ${o.siteName}` : ""}
                      </Text>
                      <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                        Last seen {ago}
                      </Text>
                    </View>
                    {lat && lng && (
                      <TouchableOpacity
                        onPress={() => Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)}
                        style={[styles.openMap, { borderColor: colors.primary }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${o.firstName} ${o.lastName}'s location in Google Maps`}
                      >
                        <Feather name="external-link" size={14} color={colors.primary} />
                        <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600" }}>Maps</Text>
                      </TouchableOpacity>
                    )}
                    <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
                  </AnimatedTouchable>
                );
              })
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 40, alignItems: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  title: { fontSize: 22, fontWeight: "700" },
  subtitle: { fontSize: 13, marginTop: 2 },
  refresh: { padding: 10, borderRadius: 8, borderWidth: 1 },
  list: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  emptyBox: { alignItems: "center", paddingVertical: 40, gap: 8 },
  empty: { fontSize: 14 },
  card: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, borderWidth: 1, gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 15, fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 2 },
  openMap: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
});
