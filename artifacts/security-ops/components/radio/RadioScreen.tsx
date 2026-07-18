import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Platform, ActivityIndicator, Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { apiRequest, API_BASE_URL } from "@/utils/api";
import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY, useAuth } from "@/contexts/AuthContext";

type Channel = {
  id: string; name: string;
  scope: "global" | "all_officers" | "admins" | "site";
  siteId: string | null; siteName?: string | null;
  adminOnly: boolean; archivedAt: string | null;
};

type Speaker = { userId: string; name: string } | null;

// MediaRecorder + MediaSource only exist in the browser. On native Expo
// the screen still works as a listener-status display, but capture and
// playback are gated behind a "v1 web only" notice. (Adding native PTT
// requires a custom dev-client with expo-audio + recording chunking;
// scheduled for v1.1.)
const IS_WEB = Platform.OS === "web";

function buildRadioWsUrl(token: string): string {
  // On native Expo this hits the same Replit domain over wss as the REST API.
  const baseHttp = API_BASE_URL.replace(/^http/, "ws").replace(/\/api$/, "");
  return `${baseHttp}/api/ws/radio?token=${encodeURIComponent(token)}`;
}

class WebChannelPlayer {
  private contexts = new Map<string, { ms: MediaSource; sb: SourceBuffer | null; queue: ArrayBuffer[]; audio: HTMLAudioElement; ready: boolean }>();
  private mime = 'audio/webm; codecs="opus"';
  ensure(channelId: string): void {
    if (this.contexts.has(channelId)) return;
    const audio = new Audio(); audio.autoplay = true;
    const ms = new MediaSource(); audio.src = URL.createObjectURL(ms);
    const ctx = { ms, sb: null as SourceBuffer | null, queue: [] as ArrayBuffer[], audio, ready: false };
    ms.addEventListener("sourceopen", () => {
      try {
        if (!MediaSource.isTypeSupported(this.mime)) return;
        const sb = ms.addSourceBuffer(this.mime); sb.mode = "sequence";
        sb.addEventListener("updateend", () => this.flush(channelId));
        ctx.sb = sb; ctx.ready = true; this.flush(channelId);
      } catch { /* unsupported */ }
    });
    this.contexts.set(channelId, ctx);
  }
  push(channelId: string, chunk: ArrayBuffer): void {
    this.ensure(channelId);
    const ctx = this.contexts.get(channelId)!;
    ctx.queue.push(chunk); this.flush(channelId);
  }
  setMuted(channelId: string, muted: boolean): void {
    const ctx = this.contexts.get(channelId);
    if (ctx) ctx.audio.muted = muted;
  }
  drop(channelId: string): void {
    const ctx = this.contexts.get(channelId);
    if (!ctx) return;
    try { ctx.audio.pause(); } catch {}
    try { URL.revokeObjectURL(ctx.audio.src); } catch {}
    this.contexts.delete(channelId);
  }
  private flush(channelId: string): void {
    const ctx = this.contexts.get(channelId);
    if (!ctx || !ctx.ready || !ctx.sb || ctx.sb.updating) return;
    const next = ctx.queue.shift(); if (!next) return;
    try { ctx.sb.appendBuffer(next); } catch { /* drop */ }
  }
  teardown(): void {
    for (const ctx of this.contexts.values()) {
      try { ctx.audio.pause(); } catch {}
      try { URL.revokeObjectURL(ctx.audio.src); } catch {}
    }
    this.contexts.clear();
  }
}

export default function RadioScreen(): React.JSX.Element {
  const colors = useColors();
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Record<string, Speaker>>({});
  const [wsReady, setWsReady] = useState(false);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<WebChannelPlayer | null>(null);
  const joinedRef = useRef<Set<string>>(new Set());
  const [leftChannels, setLeftChannels] = useState<Set<string>>(new Set());
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set());

  const activeChannel = useMemo(() => channels.find((c) => c.id === activeId) || null, [channels, activeId]);
  const isSpeakingHere = activeId ? speakers[activeId]?.userId === user?.id : false;
  const otherSpeaker = activeId && speakers[activeId]?.userId !== user?.id ? speakers[activeId] : null;

  useEffect(() => {
    apiRequest("/radio/channels")
      .then((rows: Channel[]) => {
        setChannels(rows);
        if (rows[0]) setActiveId(rows[0].id);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await storage.get(AUTH_TOKEN_KEY);
      if (!token || cancelled) return;
      if (IS_WEB) playerRef.current = new WebChannelPlayer();
      const ws = new WebSocket(buildRadioWsUrl(token));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      const abortLocalCapture = (): void => {
        if (recRef.current && recRef.current.state !== "inactive") {
          try { recRef.current.stop(); } catch { /* ignore */ }
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        recRef.current = null;
        setHolding(false);
      };
      ws.onopen = () => setWsReady(true);
      ws.onclose = () => { setWsReady(false); joinedRef.current.clear(); abortLocalCapture(); };
      ws.onerror = () => { setError("Radio connection lost."); abortLocalCapture(); };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === "speaking" && m.channelId) {
              setSpeakers((s) => ({ ...s, [m.channelId]: { userId: m.speakerUserId, name: m.speakerName } }));
            } else if (m.type === "silent" && m.channelId) {
              setSpeakers((s) => ({ ...s, [m.channelId]: null }));
            } else if (m.type === "denied") {
              setError(`Channel: ${m.reason}`);
              // Server refused our claim — never let the UI think we're live.
              abortLocalCapture();
            }
          } catch {}
          return;
        }
        if (!IS_WEB) return; // native playback path: v1.1
        const buf = ev.data as ArrayBuffer;
        const view = new Uint8Array(buf);
        if (view.length < 2) return;
        const idLen = view[0];
        const idBytes = view.slice(1, 1 + idLen);
        const audio = buf.slice(1 + idLen);
        const channelId = new TextDecoder().decode(idBytes);
        playerRef.current?.push(channelId, audio);
      };
    })();
    return () => {
      cancelled = true;
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      playerRef.current?.teardown();
      playerRef.current = null;
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

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

  useEffect(() => {
    const p = playerRef.current; if (!p) return;
    for (const c of channels) p.setMuted(c.id, mutedChannels.has(c.id));
  }, [mutedChannels, channels]);

  function leaveChannel(channelId: string): void {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "leave", channelId }));
    }
    joinedRef.current.delete(channelId);
    playerRef.current?.drop(channelId);
    setLeftChannels((s) => { const n = new Set(s); n.add(channelId); return n; });
  }
  function rejoinChannel(channelId: string): void {
    setLeftChannels((s) => { const n = new Set(s); n.delete(channelId); return n; });
  }
  function toggleMute(channelId: string): void {
    setMutedChannels((s) => {
      const n = new Set(s);
      if (n.has(channelId)) n.delete(channelId); else n.add(channelId);
      return n;
    });
  }

  async function startTalking(): Promise<void> {
    if (!activeId || !wsRef.current || otherSpeaker) return;
    setError(null);
    if (!IS_WEB) {
      // Native v1: signal intent so admins see presence, but no audio capture.
      setError("Transmission from native is coming in v1.1. Use the web app to talk for now.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24_000 });
      recRef.current = rec;
      rec.ondataavailable = async (ev) => {
        if (!ev.data?.size) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(await ev.data.arrayBuffer());
      };
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recRef.current = null;
        wsRef.current?.send(JSON.stringify({ type: "end", channelId: activeId }));
        setHolding(false);
      };
      wsRef.current.send(JSON.stringify({ type: "start", channelId: activeId }));
      rec.start(250);
      setHolding(true);
    } catch (e) {
      setError(`Microphone access denied: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function stopTalking(): void {
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
  }

  const styles = makeStyles(colors);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color={colors.primary} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Feather name="radio" size={22} color={colors.primary} />
        <Text style={styles.title}>Radio</Text>
        <View style={[styles.pill, { backgroundColor: wsReady ? "#16a34a22" : "#71717a22" }]}>
          <Text style={{ color: wsReady ? "#16a34a" : colors.mutedForeground, fontSize: 11 }}>
            {wsReady ? "Connected" : "Connecting…"}
          </Text>
        </View>
      </View>

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
              {isSpeakingHere ? (
                <Text style={[styles.statusText, { color: "#16a34a" }]}>You are transmitting…</Text>
              ) : otherSpeaker ? (
                <Text style={[styles.statusText, { color: "#0284c7" }]}>{otherSpeaker.name} is transmitting…</Text>
              ) : (
                <Text style={[styles.statusText, { color: colors.mutedForeground }]}>Channel idle</Text>
              )}
            </View>

            <Pressable
              onPressIn={startTalking}
              onPressOut={stopTalking}
              disabled={!!otherSpeaker || !wsReady || activeChannel.archivedAt !== null}
              accessibilityRole="button"
              accessibilityLabel={holding ? "Release to stop transmitting" : otherSpeaker ? "Channel busy" : "Hold to talk"}
              accessibilityHint="Press and hold to transmit on this channel"
              accessibilityState={{ disabled: !!otherSpeaker || !wsReady || activeChannel.archivedAt !== null, busy: holding }}
              style={({ pressed }) => [
                styles.ptt,
                {
                  backgroundColor: holding ? "#16a34a" : otherSpeaker ? colors.muted : "#dc2626",
                  transform: [{ scale: pressed && !otherSpeaker ? 0.97 : 1 }],
                },
              ]}
            >
              <Feather name={holding ? "mic" : otherSpeaker ? "mic-off" : "mic"} size={48} color="#fff" />
              <Text style={styles.pttLabel}>{holding ? "Release to stop" : otherSpeaker ? "Channel busy" : "Hold to talk"}</Text>
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

            {!IS_WEB && (
              <Text style={[styles.muted, { textAlign: "center", marginTop: 20, paddingHorizontal: 24 }]}>
                Presence only on this device — you can see who's transmitting, but live audio (listen and talk) is web-only in v1. Native streaming is coming in v1.1.
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
  body: { flex: 1, alignItems: "center", paddingTop: 24 },
  channelName: { fontSize: 20, fontWeight: "700", color: colors.foreground },
  muted: { color: colors.mutedForeground, fontSize: 13, marginTop: 4 },
  status: { marginTop: 16, minHeight: 22 },
  statusText: { fontSize: 14, fontWeight: "600" },
  ptt: { width: 200, height: 200, borderRadius: 100, justifyContent: "center", alignItems: "center", marginTop: 28, shadowColor: "#000", shadowOpacity: 0.18, shadowOffset: { width: 0, height: 6 }, shadowRadius: 14, elevation: 6 },
  pttLabel: { color: "#fff", fontWeight: "600", marginTop: 8 },
  smallBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  smallBtnText: { color: colors.foreground, fontSize: 13, fontWeight: "500" },
});
