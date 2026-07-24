import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { api, getToken, fetchWithAuth } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { createTransmitController } from "@/pages/radioTransmit";
import { RadioMedia } from "@/pages/Radio";
import {
  Radio as RadioIcon, Mic, MicOff, Volume2, VolumeX,
  LogOut, LogIn, Hand, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Types (mirror Radio.tsx — not exported from there)
// ---------------------------------------------------------------------------
type Channel = {
  id: string; name: string; scope: "global" | "all_officers" | "admins" | "site";
  siteId: string | null; siteName?: string | null;
  adminOnly: boolean; archivedAt: string | null; createdAt: string;
};
type Transmission = {
  id: string; channelId: string; speakerUserId: string;
  speakerName: string | null; startedAt: string; endedAt: string | null;
  durationMs: number | null; endedReason: string | null;
};
type RadioToken = {
  token: string; url: string; room: string; identity: string;
  e2eeKey: string; e2eeKeyVersion: number; canPublish: boolean; ttlSeconds: number;
};

// ---------------------------------------------------------------------------
// Helpers (same logic as Radio.tsx)
// ---------------------------------------------------------------------------
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
function reconnectDelay(attempt: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return capped / 2 + Math.random() * (capped / 2);
}
function buildRadioWsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/radio?token=${encodeURIComponent(token)}`;
}
function isMicPermissionError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  return (
    name === "NotAllowedError" || name === "SecurityError" ||
    name === "PermissionDeniedError" || msg.includes("permission") || msg.includes("denied")
  );
}
function friendlyDeniedReason(reason: string | undefined): string {
  switch (reason) {
    case "busy": return "Channel busy — someone else is transmitting.";
    case "preempted": return "An admin took over this channel.";
    case "rate_limited": return "Transmitting too quickly. Wait a moment.";
    case "forbidden": return "Not allowed to transmit on this channel.";
    case "not_joined": return "Join the channel first.";
    default: return reason ? `Denied: ${reason}` : "Transmission denied.";
  }
}
const PUBLISH_SETTLE_MS = 300;
async function settleDelay(ms: number, aborted: () => boolean): Promise<boolean> {
  const step = 50;
  for (let waited = 0; waited < ms; waited += step) {
    if (aborted()) return false;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return !aborted();
}
const MAX_LISTEN_ROOMS = 8;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function RadioPanel() {
  const { user } = useAuth();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Record<string, { name: string; userId: string } | null>>({});
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [talkState, setTalkState] = useState<"idle" | "requesting" | "connecting" | "live">("idle");
  const [publishingChannelId, setPublishingChannelId] = useState<string | null>(null);
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [wsReady, setWsReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listenEpoch, setListenEpoch] = useState(0);

  const [leftChannels, setLeftChannels] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("wcsg.radio.left") || "[]")); } catch { return new Set(); }
  });
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("wcsg.radio.muted") || "[]")); } catch { return new Set(); }
  });
  useEffect(() => { try { localStorage.setItem("wcsg.radio.left", JSON.stringify([...leftChannels])); } catch { /* ignore */ } }, [leftChannels]);
  useEffect(() => { try { localStorage.setItem("wcsg.radio.muted", JSON.stringify([...mutedChannels])); } catch { /* ignore */ } }, [mutedChannels]);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRef = useRef<RadioMedia | null>(null);
  const joinedRef = useRef<Set<string>>(new Set());
  const listenLossRef = useRef({ count: 0, lastAt: 0 });
  const userIdRef = useRef<string | undefined>(user?.id);
  const transmitRef = useRef(
    createTransmitController({
      send: (msg) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(msg));
        return true;
      },
      getUserId: () => userIdRef.current,
    }),
  );
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

  const activeChannel = useMemo(() => channels.find((c) => c.id === activeId) || null, [channels, activeId]);
  const isSpeakingHere = activeId ? speakers[activeId]?.userId === user?.id : false;
  const someoneElseSpeaking = activeId ? !!speakers[activeId] && speakers[activeId]?.userId !== user?.id : false;

  // --- token helpers ---
  async function fetchSubscribeToken(channelId: string): Promise<RadioToken | null> {
    const r = await fetchWithAuth(`/api/radio/channels/${channelId}/livekit-token`, { method: "POST" });
    if (r.status === 503) { setAudioAvailable(false); return null; }
    if (!r.ok) throw new Error(`audio token failed (${r.status})`);
    return r.json() as Promise<RadioToken>;
  }
  async function fetchPublishToken(channelId: string): Promise<RadioToken> {
    const r = await fetchWithAuth(`/api/radio/channels/${channelId}/livekit-publish-token`, { method: "POST" });
    if (!r.ok) throw new Error(`publish token failed (${r.status})`);
    return r.json() as Promise<RadioToken>;
  }

  // --- load channels ---
  useEffect(() => {
    let cancelled = false;
    api<Channel[]>("/admin/radio/channels")
      .then((cs) => {
        if (cancelled) return;
        setChannels(cs);
        const first = cs.find((c) => !c.archivedAt);
        if (first) setActiveId(first.id);
      })
      .catch((e) => setError(e?.message ?? "Failed to load channels"));
    return () => { cancelled = true; };
  }, []);

  // --- transmission log for active channel ---
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const tick = () => {
      api<Transmission[]>(`/admin/radio/channels/${activeId}/transmissions?limit=8`)
        .then((rows) => { if (!cancelled) setTransmissions(rows); })
        .catch(() => { /* ignore */ });
    };
    tick();
    const handle = window.setInterval(tick, 10_000);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [activeId]);

  // --- WS control plane ---
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    mediaRef.current = new RadioMedia();
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: number | undefined;
    let listenLossTimer: number | undefined;

    mediaRef.current.setOnListenLost(() => {
      if (cancelled) return;
      const now = Date.now();
      const s = listenLossRef.current;
      if (now - s.lastAt > 30_000) s.count = 0;
      s.lastAt = now;
      const delay = Math.min(500 * 2 ** s.count, 15_000);
      s.count += 1;
      if (listenLossTimer !== undefined) window.clearTimeout(listenLossTimer);
      listenLossTimer = window.setTimeout(() => { if (!cancelled) setListenEpoch((e) => e + 1); }, delay);
    });

    const cancelTransmit = () => {
      transmitRef.current.cancel();
      setTalkState("idle");
      setPublishingChannelId(null);
      void mediaRef.current?.stopPublish();
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      setReconnecting(true);
      const delay = reconnectDelay(attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    function connect(): void {
      if (cancelled) return;
      const ws = new WebSocket(buildRadioWsUrl(token!));
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled || wsRef.current !== ws) return;
        attempt = 0; setWsReady(true); setReconnecting(false); setError(null);
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        setWsReady(false); joinedRef.current.clear(); cancelTransmit(); scheduleReconnect();
      };
      ws.onerror = () => { if (wsRef.current === ws) cancelTransmit(); };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws || typeof ev.data !== "string") return;
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "speaking" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: { name: m.speakerName, userId: m.speakerUserId } }));
            const intent = transmitRef.current.handleSpeaking(m.channelId, m.speakerUserId);
            if (intent) void beginPublish(intent.channelId, intent.gen);
          } else if (m.type === "silent" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: null }));
          } else if (m.type === "denied") {
            setError(friendlyDeniedReason(m.reason)); cancelTransmit();
          }
        } catch { /* ignore */ }
      };
    }
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (listenLossTimer !== undefined) window.clearTimeout(listenLossTimer);
      const ws = wsRef.current;
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
      wsRef.current = null;
      mediaRef.current?.setOnListenLost(null);
      void mediaRef.current?.teardown();
      mediaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- join all visible non-archived channels ---
  useEffect(() => {
    if (!wsReady) return;
    const ws = wsRef.current;
    if (!ws) return;
    for (const c of channels) {
      if (c.archivedAt || leftChannels.has(c.id) || joinedRef.current.has(c.id)) continue;
      ws.send(JSON.stringify({ type: "join", channelId: c.id }));
      joinedRef.current.add(c.id);
    }
  }, [wsReady, channels, leftChannels]);

  // --- reconcile LiveKit listen rooms ---
  useEffect(() => {
    if (!wsReady || !audioAvailable) return;
    const media = mediaRef.current;
    if (!media) return;
    let cancelled = false;
    (async () => {
      const desired = channels
        .filter((c) => !c.archivedAt && !leftChannels.has(c.id) && !mutedChannels.has(c.id) && c.id !== publishingChannelId)
        .map((c) => c.id)
        .slice(0, MAX_LISTEN_ROOMS);
      const desiredSet = new Set(desired);
      for (const id of media.listenChannelIds()) {
        if (!desiredSet.has(id)) await media.dropListen(id);
      }
      for (const id of desired) {
        if (cancelled || media.isListening(id)) continue;
        try {
          const tok = await fetchSubscribeToken(id);
          if (!tok || cancelled) continue;
          await media.ensureListen(id, tok);
        } catch { /* ignore one channel failing */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsReady, audioAvailable, channels, leftChannels, mutedChannels, publishingChannelId, listenEpoch]);

  // --- channel actions ---
  function leaveChannel(channelId: string): void {
    wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ type: "leave", channelId }));
    joinedRef.current.delete(channelId);
    void mediaRef.current?.dropListen(channelId);
    setLeftChannels((s) => { const n = new Set(s); n.add(channelId); return n; });
  }
  function rejoinChannel(channelId: string): void {
    setLeftChannels((s) => { const n = new Set(s); n.delete(channelId); return n; });
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && !joinedRef.current.has(channelId)) {
      ws.send(JSON.stringify({ type: "join", channelId }));
      joinedRef.current.add(channelId);
    }
  }
  function toggleMute(channelId: string): void {
    setMutedChannels((s) => { const n = new Set(s); n.has(channelId) ? n.delete(channelId) : n.add(channelId); return n; });
  }

  // --- PTT ---
  async function beginPublish(channelId: string, gen: number): Promise<void> {
    const aborted = () => transmitRef.current.currentGen() !== gen;
    try {
      setTalkState("connecting");
      const tok = await fetchPublishToken(channelId);
      if (aborted()) return;
      setPublishingChannelId(channelId);
      await mediaRef.current!.startPublish(channelId, tok, aborted);
      if (aborted()) { await mediaRef.current?.stopPublish(); setPublishingChannelId(null); return; }
      setTalkState("live");
    } catch (e) {
      if (aborted()) { setPublishingChannelId(null); return; }
      setError(isMicPermissionError(e)
        ? "Microphone blocked. Allow mic access in your browser, then try again."
        : `Could not transmit: ${(e as Error).message}`);
      setTalkState("idle");
      setPublishingChannelId(null);
      wsRef.current?.send(JSON.stringify({ type: "end", channelId }));
    }
  }

  function startTalking(): void {
    if (!activeId || talkState !== "idle" || isSpeakingHere || someoneElseSpeaking) return;
    if (!audioAvailable) { setError("Live audio is not configured on this server."); return; }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setError(null);
    setTalkState("requesting");
    transmitRef.current.start(activeId);
  }

  async function stopTalking(): Promise<void> {
    if (!transmitRef.current.intent()) return;
    transmitRef.current.stop(publishingChannelId, activeId);
    setTalkState("idle");
    await mediaRef.current?.stopPublish();
    setPublishingChannelId(null);
  }

  async function takeOver(channelId: string): Promise<void> {
    try {
      await api(`/admin/radio/channels/${channelId}/preempt`, { method: "POST" });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not take over.");
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const activeChannels = channels.filter((c) => !c.archivedAt);

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <CardHeader className="px-3 py-2 border-b flex-none">
        <div className="flex items-center gap-2">
          <RadioIcon className="w-4 h-4 shrink-0" style={{ color: "var(--brand-gold, #c9a04a)" }} />
          <CardTitle className="text-sm font-semibold">Radio</CardTitle>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            wsReady ? "bg-emerald-100 text-emerald-700"
            : reconnecting ? "bg-amber-100 text-amber-800"
            : "bg-zinc-100 text-zinc-600"
          }`}>
            {wsReady ? "Connected" : reconnecting ? "Reconnecting…" : "Connecting…"}
          </span>
          <Link
            href="/radio"
            className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Manage <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 flex overflow-hidden">
        {/* ---- Channel list (left) ---- */}
        <div className="w-44 shrink-0 border-r flex flex-col overflow-hidden">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b bg-muted/30">
            Channels
          </div>
          <div className="flex-1 overflow-y-auto divide-y">
            {activeChannels.length === 0 && (
              <div className="p-3 text-xs text-muted-foreground">No channels. <Link href="/radio" className="underline">Create one →</Link></div>
            )}
            {activeChannels.map((c) => {
              const sp = speakers[c.id];
              const isActive = c.id === activeId;
              const isMuted = mutedChannels.has(c.id);
              const isLeft = leftChannels.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={`w-full text-left px-2 py-1.5 flex items-center gap-1.5 text-xs transition-colors ${
                    isActive ? "bg-accent font-medium" : "hover:bg-accent/40"
                  }`}
                >
                  {sp
                    ? <Volume2 className="w-3 h-3 text-emerald-600 animate-pulse shrink-0" />
                    : isMuted
                    ? <VolumeX className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                    : <span className="w-3 h-3 shrink-0" />}
                  <span className="truncate flex-1">{c.name}</span>
                  {isLeft && <span className="text-[9px] text-muted-foreground shrink-0">left</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- Active channel + PTT + log (right) ---- */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Alert banner */}
          {(error || !audioAvailable) && (
            <div className="mx-2 mt-2 text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 px-2 py-1 shrink-0">
              {!audioAvailable ? "Live audio not configured — presence only." : error}
            </div>
          )}

          {/* Active channel info + PTT */}
          <div className="flex-none px-3 pt-2 pb-1">
            {!activeChannel ? (
              <div className="text-xs text-muted-foreground py-2">Select a channel to transmit.</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium truncate">{activeChannel.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                    {activeChannel.scope === "site"
                      ? `Site${activeChannel.siteName ? `: ${activeChannel.siteName}` : ""}`
                      : activeChannel.scope}
                  </span>
                </div>

                {/* Speaker status */}
                <div className="mb-2 h-6 flex items-center">
                  {isSpeakingHere ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                      You are transmitting…
                    </span>
                  ) : someoneElseSpeaking ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium bg-sky-100 text-sky-700">
                      <Volume2 className="w-3 h-3 animate-pulse" />
                      {speakers[activeChannel.id]?.name} is transmitting…
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Channel idle</span>
                  )}
                </div>

                {/* PTT button */}
                <button
                  onMouseDown={startTalking}
                  onMouseUp={() => { void stopTalking(); }}
                  onMouseLeave={() => { void stopTalking(); }}
                  onTouchStart={(e) => { e.preventDefault(); startTalking(); }}
                  onTouchEnd={(e) => { e.preventDefault(); void stopTalking(); }}
                  disabled={activeChannel.archivedAt !== null || someoneElseSpeaking || !wsReady || !audioAvailable}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-md text-white text-xs font-semibold select-none transition-all ${
                    talkState === "live"
                      ? "bg-emerald-600 shadow-inner"
                      : talkState === "requesting" || talkState === "connecting"
                      ? "bg-amber-500"
                      : someoneElseSpeaking
                      ? "bg-zinc-300 cursor-not-allowed text-zinc-600"
                      : !wsReady || !audioAvailable
                      ? "bg-zinc-300 cursor-not-allowed text-zinc-500"
                      : "bg-rose-600 hover:bg-rose-700 active:scale-95"
                  }`}
                >
                  {someoneElseSpeaking
                    ? <MicOff className="w-4 h-4" />
                    : <Mic className="w-4 h-4" />}
                  {talkState === "requesting" ? "Requesting the floor…"
                    : talkState === "connecting" ? "Connecting mic…"
                    : talkState === "live" ? "Live — release to stop"
                    : someoneElseSpeaking ? "Channel busy"
                    : "Hold to Talk"}
                </button>

                {/* Sub-actions */}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2"
                    onClick={() => toggleMute(activeChannel.id)}>
                    {mutedChannels.has(activeChannel.id)
                      ? <><VolumeX className="w-3 h-3 mr-1" />Unmute</>
                      : <><Volume2 className="w-3 h-3 mr-1" />Mute</>}
                  </Button>
                  {leftChannels.has(activeChannel.id) ? (
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2"
                      onClick={() => rejoinChannel(activeChannel.id)}>
                      <LogIn className="w-3 h-3 mr-1" />Rejoin
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2"
                      onClick={() => leaveChannel(activeChannel.id)}>
                      <LogOut className="w-3 h-3 mr-1" />Leave
                    </Button>
                  )}
                  {someoneElseSpeaking && (
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2 text-destructive hover:text-destructive"
                      onClick={() => void takeOver(activeChannel.id)}>
                      <Hand className="w-3 h-3 mr-1" />Take over
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Divider */}
          <div className="border-t mx-0 mt-1" />

          {/* Transmission log */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b bg-muted/30 shrink-0">
              {activeChannel ? `Log — ${activeChannel.name}` : "Transmission Log"}
            </div>
            <div className="flex-1 overflow-y-auto divide-y text-xs">
              {transmissions.length === 0 && (
                <div className="px-3 py-2 text-muted-foreground">No transmissions yet.</div>
              )}
              {transmissions.map((t) => (
                <div key={t.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{t.speakerName ?? t.speakerUserId.slice(0, 8)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(t.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {t.endedReason ? ` · ${t.endedReason}` : ""}
                    </div>
                  </div>
                  <span className="tabular-nums text-muted-foreground shrink-0">
                    {t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : "…"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
