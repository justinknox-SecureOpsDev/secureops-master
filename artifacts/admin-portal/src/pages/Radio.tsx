import { useEffect, useMemo, useRef, useState } from "react";
import { api, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Radio as RadioIcon, Mic, MicOff, Volume2, VolumeX, Trash2, Archive, Plus, LogOut, LogIn } from "lucide-react";

type Channel = {
  id: string; name: string; scope: "global" | "all_officers" | "admins" | "site";
  siteId: string | null; siteName?: string | null;
  adminOnly: boolean; archivedAt: string | null; createdAt: string;
};
type Site = { id: string; name: string };
type Transmission = {
  id: string; channelId: string; speakerUserId: string;
  speakerName: string | null; startedAt: string; endedAt: string | null;
  durationMs: number | null; endedReason: string | null;
};

function buildRadioWsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/radio?token=${encodeURIComponent(token)}`;
}

/**
 * Multi-channel audio sink. One MediaSource per channel feeds an
 * `<audio>` element that we route playback through. Frames are
 * appended in arrival order; SourceBuffer prevents gaps from making
 * playback stall by trimming when it falls too far behind.
 */
class ChannelPlayer {
  private contexts = new Map<string, { ms: MediaSource; sb: SourceBuffer | null; queue: ArrayBuffer[]; audio: HTMLAudioElement; ready: boolean }>();
  private mime = 'audio/webm; codecs="opus"';

  ensure(channelId: string): void {
    if (this.contexts.has(channelId)) return;
    const audio = new Audio();
    audio.autoplay = true;
    const ms = new MediaSource();
    audio.src = URL.createObjectURL(ms);
    const ctx = { ms, sb: null as SourceBuffer | null, queue: [] as ArrayBuffer[], audio, ready: false };
    ms.addEventListener("sourceopen", () => {
      try {
        if (!MediaSource.isTypeSupported(this.mime)) return;
        const sb = ms.addSourceBuffer(this.mime);
        sb.mode = "sequence";
        sb.addEventListener("updateend", () => { this.flush(channelId); });
        ctx.sb = sb; ctx.ready = true;
        this.flush(channelId);
      } catch { /* unsupported */ }
    });
    this.contexts.set(channelId, ctx);
  }

  push(channelId: string, chunk: ArrayBuffer): void {
    this.ensure(channelId);
    const ctx = this.contexts.get(channelId)!;
    ctx.queue.push(chunk);
    this.flush(channelId);
  }

  setMuted(channelId: string, muted: boolean): void {
    const ctx = this.contexts.get(channelId);
    if (!ctx) return;
    ctx.audio.muted = muted;
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
    const next = ctx.queue.shift();
    if (!next) return;
    try { ctx.sb.appendBuffer(next); } catch { /* drop on overflow */ }
  }

  teardown(): void {
    for (const ctx of this.contexts.values()) {
      try { ctx.audio.pause(); } catch {}
      try { URL.revokeObjectURL(ctx.audio.src); } catch {}
    }
    this.contexts.clear();
  }
}

export default function RadioPage() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Record<string, { name: string; userId: string } | null>>({});
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [recState, setRecState] = useState<"idle" | "requesting" | "live" | "denied">("idle");
  const [sites, setSites] = useState<Site[]>([]);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<Channel["scope"]>("all_officers");
  const [newSiteId, setNewSiteId] = useState<string>("");
  const [wsReady, setWsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<ChannelPlayer | null>(null);
  const joinedRef = useRef<Set<string>>(new Set());
  // Channels the user explicitly left or muted. Persisted across the
  // session so a refresh respects their last preference.
  const [leftChannels, setLeftChannels] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("wcsg.radio.left") || "[]")); } catch { return new Set(); }
  });
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("wcsg.radio.muted") || "[]")); } catch { return new Set(); }
  });
  useEffect(() => { try { localStorage.setItem("wcsg.radio.left", JSON.stringify([...leftChannels])); } catch {} }, [leftChannels]);
  useEffect(() => { try { localStorage.setItem("wcsg.radio.muted", JSON.stringify([...mutedChannels])); } catch {} }, [mutedChannels]);

  const activeChannel = useMemo(() => channels.find((c) => c.id === activeId) || null, [channels, activeId]);
  const isSpeakingHere = activeId ? speakers[activeId]?.userId === user?.id : false;
  const someoneElseSpeaking = activeId ? !!speakers[activeId] && speakers[activeId]?.userId !== user?.id : false;

  // --- load channels + sites ---
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<Channel[]>("/admin/radio/channels"),
      api<Site[]>("/sites").catch(() => []),
    ]).then(([cs, ss]) => {
      if (cancelled) return;
      setChannels(cs);
      setSites(ss as Site[]);
      const firstActive = cs.find((c) => !c.archivedAt);
      if (firstActive) setActiveId(firstActive.id);
    }).catch((e) => setError(e?.message ?? "Failed to load channels"));
    return () => { cancelled = true; };
  }, []);

  // --- transmission log for the selected channel ---
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const tick = () => {
      api<Transmission[]>(`/admin/radio/channels/${activeId}/transmissions?limit=50`)
        .then((rows) => { if (!cancelled) setTransmissions(rows); })
        .catch(() => { /* ignore */ });
    };
    tick();
    const handle = window.setInterval(tick, 10_000);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [activeId]);

  // --- WS connection ---
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    playerRef.current = new ChannelPlayer();
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
      setRecState("idle");
    };

    ws.onopen = () => setWsReady(true);
    ws.onclose = () => { setWsReady(false); joinedRef.current.clear(); abortLocalCapture(); };
    ws.onerror = () => { setError("Radio connection lost. Reload to retry."); abortLocalCapture(); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "speaking" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: { name: m.speakerName, userId: m.speakerUserId } }));
          } else if (m.type === "silent" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: null }));
          } else if (m.type === "denied") {
            setError(`Channel ${m.channelId}: ${m.reason}`);
            // Server refused our claim — never let the UI think we're live.
            abortLocalCapture();
          }
        } catch { /* ignore */ }
        return;
      }
      // binary: [1 byte channelId length][channelId bytes][audio bytes]
      const buf = ev.data as ArrayBuffer;
      const view = new Uint8Array(buf);
      if (view.length < 2) return;
      const idLen = view[0];
      const idBytes = view.slice(1, 1 + idLen);
      const audio = buf.slice(1 + idLen);
      const channelId = new TextDecoder().decode(idBytes);
      playerRef.current?.push(channelId, audio);
    };

    return () => {
      try { ws.close(); } catch {}
      wsRef.current = null;
      playerRef.current?.teardown();
      playerRef.current = null;
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // --- join all visible non-archived channels once the WS is up ---
  useEffect(() => {
    if (!wsReady) return;
    const ws = wsRef.current;
    if (!ws) return;
    for (const c of channels) {
      if (c.archivedAt) continue;
      if (leftChannels.has(c.id)) continue;
      if (joinedRef.current.has(c.id)) continue;
      ws.send(JSON.stringify({ type: "join", channelId: c.id }));
      joinedRef.current.add(c.id);
    }
  }, [wsReady, channels, leftChannels]);

  // Apply mute preferences whenever they change (and after audio elements exist).
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

  async function startTalking(): Promise<void> {
    if (!activeId || !wsRef.current || isSpeakingHere || someoneElseSpeaking) return;
    setError(null);
    setRecState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24_000 });
      recRef.current = rec;
      rec.ondataavailable = async (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const buf = await ev.data.arrayBuffer();
        ws.send(buf);
      };
      rec.onstop = () => {
        if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
        recRef.current = null;
        setRecState("idle");
        wsRef.current?.send(JSON.stringify({ type: "end", channelId: activeId }));
      };
      wsRef.current.send(JSON.stringify({ type: "start", channelId: activeId }));
      rec.start(250); // 250ms timeslices ≈ sub-second perceived latency
      setRecState("live");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Microphone access denied: ${msg}`);
      setRecState("denied");
    }
  }

  function stopTalking(): void {
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
  }

  async function createChannel(): Promise<void> {
    if (!newName.trim()) return;
    try {
      const created = await api<Channel>("/admin/radio/channels", {
        method: "POST",
        body: { name: newName.trim(), scope: newScope, siteId: newScope === "site" ? newSiteId : null },
      });
      setChannels((cs) => [...cs, created]);
      setNewName("");
      setNewSiteId("");
      setActiveId(created.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create channel");
    }
  }

  async function archiveChannel(id: string, archived: boolean): Promise<void> {
    const updated = await api<Channel>(`/admin/radio/channels/${id}`, { method: "PATCH", body: { archived } });
    setChannels((cs) => cs.map((c) => (c.id === id ? updated : c)));
  }
  async function deleteChannel(id: string): Promise<void> {
    if (!confirm("Delete this radio channel? Transmission audit rows will be removed too.")) return;
    await api(`/admin/radio/channels/${id}`, { method: "DELETE" });
    setChannels((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <RadioIcon className="w-6 h-6 brand-gold" />
        <h1 className="text-2xl font-semibold">Radio</h1>
        <span className={`ml-2 text-xs px-2 py-0.5 rounded ${wsReady ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-600"}`}>
          {wsReady ? "Connected" : "Connecting…"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Live push-to-talk radio. Hold the button to transmit; one speaker per channel.
        Audio is ephemeral — only speaker and timing metadata are kept for audit.
      </p>

      {error && (
        <div className="mb-4 text-sm rounded border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <div className="rounded border bg-card">
            <div className="px-3 py-2 border-b text-xs uppercase tracking-wider opacity-60">Channels</div>
            <div className="divide-y">
              {channels.length === 0 && <div className="p-3 text-sm opacity-60">No channels yet.</div>}
              {channels.map((c) => {
                const active = c.id === activeId;
                const sp = speakers[c.id];
                return (
                  <button
                    key={c.id}
                    onClick={() => setActiveId(c.id)}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between text-sm ${active ? "bg-accent" : "hover:bg-accent/40"} ${c.archivedAt ? "opacity-50" : ""}`}
                  >
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {c.name}
                        {sp && <Volume2 className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />}
                      </div>
                      <div className="text-[11px] opacity-60">
                        {c.scope === "site" ? `Site${c.siteName ? `: ${c.siteName}` : ""}` : c.scope}
                        {c.archivedAt && " · archived"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded border bg-card mt-4 p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider opacity-60">New channel</div>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. Mall — Day Shift)"
              className="w-full text-sm border rounded px-2 py-1 bg-background"
            />
            <select value={newScope} onChange={(e) => setNewScope(e.target.value as Channel["scope"])} className="w-full text-sm border rounded px-2 py-1 bg-background">
              <option value="all_officers">All officers</option>
              <option value="global">Global (everyone)</option>
              <option value="admins">Admins only</option>
              <option value="site">Site-scoped</option>
            </select>
            {newScope === "site" && (
              <select value={newSiteId} onChange={(e) => setNewSiteId(e.target.value)} className="w-full text-sm border rounded px-2 py-1 bg-background">
                <option value="">Pick a site…</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            <Button size="sm" onClick={createChannel} disabled={!newName.trim() || (newScope === "site" && !newSiteId)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Create
            </Button>
          </div>
        </div>

        <div className="md:col-span-2 space-y-4">
          <div className="rounded border bg-card p-6 text-center">
            {!activeChannel && <div className="text-sm opacity-60">Select a channel to transmit.</div>}
            {activeChannel && (
              <>
                <div className="text-lg font-semibold">{activeChannel.name}</div>
                <div className="text-xs opacity-60 mb-4">
                  {activeChannel.scope === "site" ? `Site${activeChannel.siteName ? `: ${activeChannel.siteName}` : ""}` : activeChannel.scope}
                </div>

                <div className="mb-4 min-h-[28px] text-sm">
                  {isSpeakingHere && <span className="text-emerald-600 font-medium">You are transmitting…</span>}
                  {someoneElseSpeaking && <span className="text-sky-600 font-medium">{speakers[activeChannel.id]?.name} is transmitting…</span>}
                  {!isSpeakingHere && !someoneElseSpeaking && <span className="opacity-60">Channel idle</span>}
                </div>

                <button
                  onMouseDown={startTalking}
                  onMouseUp={stopTalking}
                  onMouseLeave={() => { if (recState === "live") stopTalking(); }}
                  onTouchStart={(e) => { e.preventDefault(); startTalking(); }}
                  onTouchEnd={(e) => { e.preventDefault(); stopTalking(); }}
                  disabled={activeChannel.archivedAt !== null || someoneElseSpeaking || !wsReady}
                  className={`mx-auto w-40 h-40 rounded-full flex items-center justify-center text-white text-lg font-semibold transition-transform select-none ${
                    isSpeakingHere ? "bg-emerald-600 scale-105 shadow-lg" :
                    someoneElseSpeaking ? "bg-zinc-400 cursor-not-allowed" :
                    "bg-rose-600 hover:bg-rose-700 active:scale-95"
                  }`}
                >
                  {isSpeakingHere ? <Mic className="w-10 h-10" /> : someoneElseSpeaking ? <MicOff className="w-10 h-10" /> : <Mic className="w-10 h-10" />}
                </button>
                <div className="text-xs opacity-60 mt-3">
                  Hold to talk — release to stop. {recState === "requesting" && "Requesting microphone…"}
                </div>

                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => toggleMute(activeChannel.id)}>
                    {mutedChannels.has(activeChannel.id)
                      ? <><VolumeX className="w-3.5 h-3.5 mr-1" /> Unmute</>
                      : <><Volume2 className="w-3.5 h-3.5 mr-1" /> Mute</>}
                  </Button>
                  {leftChannels.has(activeChannel.id) ? (
                    <Button variant="outline" size="sm" onClick={() => rejoinChannel(activeChannel.id)}>
                      <LogIn className="w-3.5 h-3.5 mr-1" /> Rejoin
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => leaveChannel(activeChannel.id)}>
                      <LogOut className="w-3.5 h-3.5 mr-1" /> Leave
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => archiveChannel(activeChannel.id, !activeChannel.archivedAt)}>
                    <Archive className="w-3.5 h-3.5 mr-1" />
                    {activeChannel.archivedAt ? "Unarchive" : "Archive"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => deleteChannel(activeChannel.id)}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                  </Button>
                </div>
              </>
            )}
          </div>

          {activeChannel && (
            <div className="rounded border bg-card">
              <div className="px-3 py-2 border-b text-xs uppercase tracking-wider opacity-60">
                Transmission log — {activeChannel.name}
              </div>
              <div className="divide-y text-sm max-h-[360px] overflow-y-auto">
                {transmissions.length === 0 && <div className="p-3 opacity-60">No transmissions yet.</div>}
                {transmissions.map((t) => (
                  <div key={t.id} className="px-3 py-2 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{t.speakerName ?? t.speakerUserId.slice(0, 8)}</div>
                      <div className="text-[11px] opacity-60">
                        {new Date(t.startedAt).toLocaleString()}
                        {t.endedReason && ` · ${t.endedReason}`}
                      </div>
                    </div>
                    <div className="text-xs tabular-nums opacity-70">
                      {t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : "…"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
