import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  ActivityIndicator, Pressable, AppState,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiRequest, getApiBaseUrl } from "@/utils/api";
import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY, useAuth } from "@/contexts/AuthContext";
import { createRadioMedia } from "./radioMedia";
import type { RadioMedia, RadioToken } from "./radioTypes";
import { createTransmitController, type TransmitController } from "./radioTransmit";

type Channel = {
  id: string; name: string;
  scope: "global" | "all_officers" | "admins" | "site";
  siteId: string | null; siteName?: string | null;
  adminOnly: boolean; archivedAt: string | null;
};

type Speaker = { userId: string; name: string } | null;
type TalkState = "idle" | "requesting" | "connecting" | "live";

function buildRadioWsUrl(token: string): string {
  // On native Expo this hits the same Replit domain over wss as the REST API.
  const baseHttp = getApiBaseUrl().replace(/^http/, "ws").replace(/\/api$/, "");
  return `${baseHttp}/api/ws/radio?token=${encodeURIComponent(token)}`;
}

// Control-WS reconnect backoff. The LiveKit media room reconnects itself; this
// is purely for the JSON control plane (presence + speaker lock).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
function reconnectDelay(attempt: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return capped / 2 + Math.random() * (capped / 2); // jitter: 50–100% of cap
}

/** Turn a server `denied` reason code into something an officer can act on. */
function friendlyDeniedReason(reason: string | undefined): string {
  switch (reason) {
    case "busy": return "Someone else is already transmitting on this channel.";
    case "preempted": return "An admin took over this channel.";
    case "rate_limited": return "You're transmitting too quickly. Wait a moment and try again.";
    case "forbidden": return "You're not allowed to transmit on this channel.";
    case "not_joined": return "Join the channel before transmitting.";
    default: return reason ? `Transmission denied (${reason}).` : "Transmission denied.";
  }
}

/** A mic-permission rejection from createLocalAudioTrack / native WebRTC. */
function isMicPermissionError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" || msg.includes("permission") || msg.includes("denied") || msg.includes("not allowed");
}

/**
 * POST a radio LiveKit token endpoint. Returns the parsed token, or null with
 * the HTTP status so callers can special-case 503 (LiveKit not configured on
 * this server) and 409 (someone else holds the speaker lock).
 */
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

export default function RadioScreen(): React.JSX.Element {
  const colors = useColors();
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Record<string, Speaker>>({});
  const [wsReady, setWsReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [talkState, setTalkState] = useState<TalkState>("idle");
  const [publishingChannelId, setPublishingChannelId] = useState<string | null>(null);
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRef = useRef<RadioMedia | null>(null);
  const joinedRef = useRef<Set<string>>(new Set());
  const [leftChannels, setLeftChannels] = useState<Set<string>>(new Set());
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set());
  // Bumped when a listen room dies UNEXPECTEDLY (server eviction, network
  // drop) so the listen-reconcile effect re-runs and reconnects — otherwise
  // none of its deps change and the user stays silently deaf on the channel.
  const [listenEpoch, setListenEpoch] = useState(0);
  const listenLossRef = useRef({ count: 0, lastAt: 0 });

  const supportsAudio = mediaRef.current?.supportsAudio ?? createRadioMedia().supportsAudio;

  const activeChannel = useMemo(() => channels.find((c) => c.id === activeId) || null, [channels, activeId]);
  // Site radio channels get their own labelled section so a dispatcher can jump
  // straight to any site's channel without hunting through the chip row (or
  // opening the live map). Sorted by site name for scanability.
  const siteChannels = useMemo(
    () =>
      channels
        .filter((c) => c.scope === "site" && !c.archivedAt)
        .sort((a, b) => (a.siteName ?? a.name).localeCompare(b.siteName ?? b.name)),
    [channels],
  );
  const isSpeakingHere = activeId ? speakers[activeId]?.userId === user?.id : false;
  const otherSpeaker = activeId && speakers[activeId] && speakers[activeId]?.userId !== user?.id ? speakers[activeId] : null;
  const isTransmitting = talkState === "live" || talkState === "requesting" || talkState === "connecting";

  const userIdRef = useRef<string | undefined>(user?.id);
  // Synchronous push-to-talk transmit-intent state machine. Owns the generation
  // counter + the intent that's set the instant PTT is pressed and cleared the
  // instant it's released, so a late 'speaking' echo arriving after release can
  // NEVER start a publish (React state / ref mirrors lag by a tick; this does
  // not). Unit-tested in __tests__/radioTransmit.test.ts. See the memory note
  // ptt-transmit-intent-sync-ref.md.
  const transmitRef = useRef<TransmitController | null>(null);
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
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

  useEffect(() => {
    apiRequest("/radio/channels")
      .then((rows: Channel[]) => {
        setChannels(rows);
        if (rows[0]) setActiveId(rows[0].id);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // --- WS control plane (presence + speaker lock signalling) ---
  // Auto-reconnects with capped exponential backoff + jitter so a dropped
  // control socket (backgrounding, flaky cell signal) recovers silently. The
  // join effect re-runs on each reopen (joinedRef cleared on close) and the
  // LiveKit listen room reconnects itself. We deliberately do NOT re-claim the
  // lock or re-publish on reconnect — a dropped speaker must press PTT again.
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let listenLossTimer: ReturnType<typeof setTimeout> | undefined;
    mediaRef.current = createRadioMedia();
    // Self-heal listening: when a listen room dies unexpectedly, bump
    // listenEpoch (after a small backoff that grows if losses repeat within
    // 30s — so a flapping SFU can't drive a tight reconnect loop) to re-run
    // the reconcile effect, which refetches a token and reconnects.
    mediaRef.current.setOnListenLost(() => {
      if (cancelled) return;
      const now = Date.now();
      const s = listenLossRef.current;
      if (now - s.lastAt > 30_000) s.count = 0;
      s.lastAt = now;
      const delay = Math.min(500 * 2 ** s.count, 15_000);
      s.count += 1;
      if (listenLossTimer !== undefined) clearTimeout(listenLossTimer);
      listenLossTimer = setTimeout(() => {
        if (!cancelled) setListenEpoch((e) => e + 1);
      }, delay);
    });

    const cancelTransmit = (): void => {
      transmitRef.current!.cancel(); // abort in-flight publish + drop intent (no 'end')
      setTalkState("idle");
      setPublishingChannelId(null);
      void mediaRef.current?.stopPublish();
    };

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      setReconnecting(true);
      const delay = reconnectDelay(attempt);
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
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return; // a newer socket already took over
        setWsReady(false);
        joinedRef.current.clear();
        cancelTransmit();
        scheduleReconnect();
      };
      // Don't schedule from onerror — onclose always follows and owns retry.
      ws.onerror = () => { if (wsRef.current === ws) cancelTransmit(); };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return; // ignore stale socket events
        if (typeof ev.data !== "string") return; // audio rides LiveKit, not this socket
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "speaking" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: { userId: m.speakerUserId, name: m.speakerName } }));
            // The server confirmed WE hold the lock — mint a publish token and
            // go live on that channel's LiveKit room. The controller gates on the
            // synchronous transmit intent: if PTT was already released, intent is
            // null and a late echo is ignored (no publish-after-release).
            const intent = transmitRef.current!.handleSpeaking(m.channelId, m.speakerUserId);
            if (intent) void beginPublish(intent.channelId, intent.gen);
          } else if (m.type === "silent" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: null }));
          } else if (m.type === "denied") {
            setError(friendlyDeniedReason(m.reason));
            cancelTransmit();
          }
        } catch { /* ignore */ }
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (listenLossTimer !== undefined) clearTimeout(listenLossTimer);
      const ws = wsRef.current;
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
      wsRef.current = null;
      mediaRef.current?.setOnListenLost(null);
      void mediaRef.current?.teardown();
      mediaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- resume re-reconcile after unlock/foreground ---
  // While the app is suspended (locked phone without the audio keep-alive, or
  // iOS reclaiming resources) all JS timers freeze, so the listen self-heal
  // backoff and the WS reconnect timer may never have fired. On return to
  // "active": bump listenEpoch so the reconcile effect re-checks the listen
  // room (no-op when healthy), nudge the control WS with a protocol ping —
  // a socket the OS silently killed will fail the send / surface onclose,
  // which owns reconnection — and replay the native silent keep-alive player
  // (an AVAudioSession interruption like a phone call pauses it and nothing
  // resumes it automatically).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (status) => {
      if (status !== "active") return;
      setListenEpoch((e) => e + 1);
      mediaRef.current?.resumeKeepAlive?.();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* onclose handles it */ }
      }
    });
    return () => sub.remove();
  }, []);

  // --- join all visible non-archived channels (control plane) once WS is up ---
  useEffect(() => {
    if (!wsReady) return;
    const ws = wsRef.current; if (!ws) return;
    for (const c of channels) {
      if (c.archivedAt || joinedRef.current.has(c.id)) continue;
      if (leftChannels.has(c.id)) continue;
      ws.send(JSON.stringify({ type: "join", channelId: c.id }));
      joinedRef.current.add(c.id);
    }
  }, [wsReady, channels, leftChannels]);

  // --- reconcile the LiveKit listen room to the ACTIVE channel only ---
  // Unlike the admin portal (which monitors many channels at once), an officer
  // on a phone listens to the one channel they have selected — fewer media
  // connections, clearer audio, less battery.
  useEffect(() => {
    if (!wsReady || !audioAvailable) return;
    const media = mediaRef.current;
    if (!media || !media.supportsAudio) return;
    let cancelled = false;
    (async () => {
      const wantActive =
        !!activeId && !!activeChannel && !activeChannel.archivedAt &&
        !leftChannels.has(activeId) && !mutedChannels.has(activeId) &&
        activeId !== publishingChannelId;
      const desired = wantActive && activeId ? [activeId] : [];
      const desiredSet = new Set(desired);
      for (const id of media.listenChannelIds()) {
        if (!desiredSet.has(id)) await media.dropListen(id);
      }
      for (const id of desired) {
        if (cancelled) return;
        if (media.isListening(id)) continue;
        try {
          const { status, data } = await postRadioToken(`/radio/channels/${id}/livekit-token`);
          if (!data) { if (status === 503) setAudioAvailable(false); continue; }
          if (cancelled) return;
          await media.ensureListen(id, data);
          // If the active channel changed while we were connecting, this room is
          // no longer desired — drop it so native stays active-channel-only.
          if (cancelled) { await media.dropListen(id); return; }
        } catch (e) {
          // One channel failing to connect audio shouldn't break presence.
          console.warn("[radio] listen connect failed", id, e);
        }
      }
    })();
    return () => { cancelled = true; };
    // listenEpoch: bumped by setOnListenLost when a listen room dies
    // unexpectedly — forces this effect to re-run and reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsReady, audioAvailable, activeId, activeChannel, leftChannels, mutedChannels, publishingChannelId, listenEpoch]);

  function leaveChannel(channelId: string): void {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "leave", channelId }));
    }
    joinedRef.current.delete(channelId);
    void mediaRef.current?.dropListen(channelId);
    setLeftChannels((s) => { const n = new Set(s); n.add(channelId); return n; });
  }
  function rejoinChannel(channelId: string): void {
    setLeftChannels((s) => { const n = new Set(s); n.delete(channelId); return n; });
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && !joinedRef.current.has(channelId)) {
      ws.send(JSON.stringify({ type: "join", channelId }));
      joinedRef.current.add(channelId);
    }
  }
  function toggleMute(channelId: string): void {
    setMutedChannels((s) => {
      const n = new Set(s);
      if (n.has(channelId)) n.delete(channelId); else n.add(channelId);
      return n;
    });
  }

  async function beginPublish(channelId: string, gen: number): Promise<void> {
    // `gen` is the transmit generation that owned the intent when the lock was
    // requested. If it changes (PTT released, WS dropped) while we're fetching a
    // token / connecting, bail out and tear down so we never transmit after the
    // user let go.
    const aborted = (): boolean => transmitRef.current!.currentGen() !== gen;
    try {
      // Lock confirmed; mic isn't live yet — surface "connecting" until it is.
      setTalkState("connecting");
      const { status, data } = await postRadioToken(`/radio/channels/${channelId}/livekit-publish-token`);
      if (aborted()) return; // stopTalking already sent 'end' + cleaned up
      if (!data) {
        if (status === 503) setAudioAvailable(false);
        throw new Error(status === 409 ? "Someone else is transmitting." : `publish token failed (${status})`);
      }
      setPublishingChannelId(channelId);
      await mediaRef.current!.startPublish(channelId, data, aborted);
      if (aborted()) { await mediaRef.current?.stopPublish(); setPublishingChannelId(null); return; }
      setTalkState("live");
    } catch (e) {
      setError(isMicPermissionError(e)
        ? "Microphone access is off. Enable it for SecureOps in your device Settings, then try again."
        : `Could not start transmitting: ${(e as Error).message}`);
      setTalkState("idle");
      setPublishingChannelId(null);
      wsRef.current?.send(JSON.stringify({ type: "end", channelId }));
    }
  }

  function startTalking(): void {
    if (!activeId || talkState !== "idle" || isSpeakingHere || otherSpeaker) return;
    if (!supportsAudio) {
      setError("Live radio audio is in the SecureOps app on your phone. This preview shows presence only.");
      return;
    }
    if (!audioAvailable) { setError("Live radio audio is not configured on this server."); return; }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setError(null);
    setTalkState("requesting");
    // Records intent synchronously BEFORE sending 'start' (so the echo handler,
    // which can fire before any React state settles, sees it), then claims the
    // lock; we publish once the server echoes our 'speaking'.
    transmitRef.current!.start(activeId);
  }

  async function stopTalking(): Promise<void> {
    // Gate on the SYNCHRONOUS intent, not React `talkState` — a fast
    // press/release can run this from a render where `talkState` is still
    // "idle", and gating on that would skip cleanup and leak a publish.
    if (!transmitRef.current!.intent()) return; // nothing requested or active
    // The controller bumps the generation + clears intent FIRST (so any in-flight
    // beginPublish/startPublish aborts itself and a late 'speaking' echo can't
    // start a new publish), then sends WS 'end' for the publishing/active channel.
    transmitRef.current!.stop(publishingChannelId, activeId);
    setTalkState("idle");
    await mediaRef.current?.stopPublish();
    setPublishingChannelId(null);
  }

  const styles = makeStyles(colors);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color={colors.primary} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const pttDisabled = !!otherSpeaker || !wsReady || (activeChannel?.archivedAt ?? null) !== null || !supportsAudio || !audioAvailable;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Feather name="radio" size={22} color={colors.primary} />
        <Text style={styles.title}>Radio</Text>
        <View style={[styles.pill, { backgroundColor: wsReady ? "#16a34a22" : reconnecting ? "#f59e0b22" : "#71717a22" }]}>
          <Text style={{ color: wsReady ? "#16a34a" : reconnecting ? "#b45309" : colors.mutedForeground, fontSize: 11 }}>
            {wsReady ? "Connected" : reconnecting ? "Reconnecting…" : "Connecting…"}
          </Text>
        </View>
      </View>

      {supportsAudio && !audioAvailable && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            Live audio is not configured on this server. Presence still works, but you can't hear or transmit yet.
          </Text>
        </View>
      )}

      {error && (
        <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
        {channels.map((c) => {
          const active = c.id === activeId;
          const sp = speakers[c.id];
          return (
            <TouchableOpacity
              key={c.id}
              onPress={() => setActiveId(c.id)}
              style={[styles.chip, active && { backgroundColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${c.name} channel${sp ? `, ${sp.name} transmitting` : ""}`}
            >
              <Text style={[styles.chipText, active && { color: "#fff" }]}>{c.name}</Text>
              {sp && <Feather name="volume-2" size={12} color={active ? "#fff" : "#16a34a"} style={{ marginLeft: 4 }} />}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {siteChannels.length > 0 && (
        <View style={styles.siteSection}>
          <Text style={styles.siteSectionTitle}>Site Channels</Text>
          <ScrollView style={styles.siteList} showsVerticalScrollIndicator={false}>
            {siteChannels.map((c) => {
              const active = c.id === activeId;
              const sp = speakers[c.id];
              const label = c.siteName ?? c.name;
              return (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => setActiveId(c.id)}
                  style={[styles.siteRow, active && { borderColor: colors.primary, backgroundColor: colors.card }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Site channel ${label}${sp ? `, ${sp.name} transmitting` : ""}`}
                >
                  <Feather name="map-pin" size={14} color={active ? colors.primary : colors.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.siteRowName, active && { color: colors.primary }]} numberOfLines={1}>{label}</Text>
                    {c.siteName && c.name !== c.siteName && (
                      <Text style={styles.siteRowSub} numberOfLines={1}>{c.name}</Text>
                    )}
                  </View>
                  {sp && <Feather name="volume-2" size={14} color="#16a34a" />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.body}>
        {!activeChannel ? (
          <Text style={styles.muted}>No channels available.</Text>
        ) : (
          <>
            <Text style={styles.channelName}>{activeChannel.name}</Text>
            <Text style={styles.muted}>
              {activeChannel.scope === "site" ? `Site${activeChannel.siteName ? `: ${activeChannel.siteName}` : ""}` : activeChannel.scope}
            </Text>

            <View style={styles.status}>
              {isSpeakingHere || isTransmitting ? (
                <View style={[styles.banner, { backgroundColor: "#16a34a1a" }]}>
                  <View style={[styles.bannerDot, { backgroundColor: "#16a34a" }]} />
                  <Text style={[styles.bannerText, { color: "#15803d" }]}>
                    {talkState === "requesting" ? "Requesting the floor…"
                      : talkState === "connecting" ? "Connecting your mic…"
                      : "You are transmitting…"}
                  </Text>
                </View>
              ) : otherSpeaker ? (
                <View style={[styles.banner, { backgroundColor: "#0284c71a" }]}>
                  <Feather name="volume-2" size={16} color="#0284c7" />
                  <Text style={[styles.bannerText, { color: "#0369a1" }]}>{otherSpeaker.name} is transmitting…</Text>
                </View>
              ) : (
                <Text style={[styles.statusText, { color: colors.mutedForeground }]}>Channel idle</Text>
              )}
            </View>

            <Pressable
              onPressIn={startTalking}
              onPressOut={() => { void stopTalking(); }}
              disabled={pttDisabled}
              accessibilityRole="button"
              accessibilityLabel={isTransmitting ? "Release to stop transmitting" : otherSpeaker ? "Channel busy" : "Hold to talk"}
              accessibilityHint="Press and hold to transmit on this channel"
              accessibilityState={{ disabled: pttDisabled, busy: isTransmitting }}
              style={({ pressed }) => [
                styles.ptt,
                {
                  backgroundColor: isTransmitting ? "#16a34a" : pttDisabled ? colors.muted : "#dc2626",
                  transform: [{ scale: pressed && !pttDisabled ? 0.97 : 1 }],
                },
              ]}
            >
              <Feather name={isTransmitting ? "mic" : otherSpeaker ? "mic-off" : "mic"} size={48} color="#fff" />
              <Text style={styles.pttLabel}>{isTransmitting ? "Release to stop" : otherSpeaker ? "Channel busy" : "Hold to talk"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
              <TouchableOpacity
                onPress={() => toggleMute(activeChannel.id)}
                style={styles.smallBtn}
                accessibilityRole="button"
                accessibilityLabel={mutedChannels.has(activeChannel.id) ? `Unmute ${activeChannel.name}` : `Mute ${activeChannel.name}`}
              >
                <Feather name={mutedChannels.has(activeChannel.id) ? "volume-x" : "volume-2"} size={14} color={colors.foreground} />
                <Text style={styles.smallBtnText}>{mutedChannels.has(activeChannel.id) ? "Unmute" : "Mute"}</Text>
              </TouchableOpacity>
              {leftChannels.has(activeChannel.id) ? (
                <TouchableOpacity onPress={() => rejoinChannel(activeChannel.id)} style={styles.smallBtn} accessibilityRole="button" accessibilityLabel={`Rejoin ${activeChannel.name}`}>
                  <Feather name="log-in" size={14} color={colors.foreground} />
                  <Text style={styles.smallBtnText}>Rejoin</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => leaveChannel(activeChannel.id)} style={styles.smallBtn} accessibilityRole="button" accessibilityLabel={`Leave ${activeChannel.name}`}>
                  <Feather name="log-out" size={14} color={colors.foreground} />
                  <Text style={styles.smallBtnText}>Leave</Text>
                </TouchableOpacity>
              )}
            </View>

            {!supportsAudio && (
              <Text style={[styles.muted, { textAlign: "center", marginTop: 20, paddingHorizontal: 24 }]}>
                Presence only in this preview — you can see who's transmitting. Live audio (listen and talk) is end-to-end encrypted in the SecureOps app on your phone.
              </Text>
            )}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: "700", color: colors.foreground, flex: 1 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  errorBox: { marginHorizontal: 16, padding: 10, borderRadius: 8, backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a", marginBottom: 8 },
  errorText: { color: "#92400e", fontSize: 12 },
  chipRow: { maxHeight: 48, flexGrow: 0 },
  chip: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  chipText: { color: colors.foreground, fontSize: 13 },
  siteSection: { paddingHorizontal: 16, paddingTop: 12 },
  siteSectionTitle: { fontSize: 12, fontWeight: "700", color: colors.mutedForeground, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  siteList: { maxHeight: 168, flexGrow: 0 },
  siteRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, marginBottom: 6 },
  siteRowName: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  siteRowSub: { color: colors.mutedForeground, fontSize: 11, marginTop: 1 },
  body: { flex: 1, alignItems: "center", paddingTop: 24 },
  channelName: { fontSize: 20, fontWeight: "700", color: colors.foreground },
  muted: { color: colors.mutedForeground, fontSize: 13, marginTop: 4 },
  status: { marginTop: 16, minHeight: 36, justifyContent: "center" },
  statusText: { fontSize: 14, fontWeight: "600" },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  bannerDot: { width: 8, height: 8, borderRadius: 4 },
  bannerText: { fontSize: 14, fontWeight: "700" },
  ptt: { width: 200, height: 200, borderRadius: 100, justifyContent: "center", alignItems: "center", marginTop: 28, shadowColor: "#000", shadowOpacity: 0.18, shadowOffset: { width: 0, height: 6 }, shadowRadius: 14, elevation: 6 },
  pttLabel: { color: "#fff", fontWeight: "600", marginTop: 8 },
  smallBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  smallBtnText: { color: colors.foreground, fontSize: 13, fontWeight: "500" },
});
