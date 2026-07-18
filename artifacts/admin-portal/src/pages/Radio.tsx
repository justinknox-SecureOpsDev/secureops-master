import { useEffect, useMemo, useRef, useState } from "react";
import { api, getToken, fetchWithAuth } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { createTransmitController, type TransmitController } from "./radioTransmit";
import { Button } from "@/components/ui/button";
import { Radio as RadioIcon, Mic, MicOff, Volume2, VolumeX, Trash2, Archive, Plus, LogOut, LogIn, Pencil, Hand, Check, X } from "lucide-react";
import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  ExternalE2EEKeyProvider,
  type RemoteTrack,
  type LocalAudioTrack,
} from "livekit-client";

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

/** Token payload from the radio LiveKit endpoints (subscribe or publish). */
type RadioToken = {
  token: string; url: string; room: string; identity: string;
  e2eeKey: string; e2eeKeyVersion: number; canPublish: boolean; ttlSeconds: number;
};

// Browser practicality cap on simultaneous LiveKit listen connections. Muted
// channels don't count — they hold no media connection (presence still rides
// the control-plane WS).
const MAX_LISTEN_ROOMS = 8;

function buildRadioWsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/radio?token=${encodeURIComponent(token)}`;
}

// Control-WS reconnect backoff. The LiveKit media rooms reconnect themselves;
// this is purely for the JSON control plane (presence + speaker lock).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
function reconnectDelay(attempt: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return capped / 2 + Math.random() * (capped / 2); // jitter: 50–100% of cap
}

/** Turn a server `denied` reason code into something an admin can act on. */
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

/** A mic-permission rejection from getUserMedia / createLocalAudioTrack. */
function isMicPermissionError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" || msg.includes("permission") || msg.includes("denied");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * LiveKit media plane for the radio. Our `/api/ws/radio` socket stays the
 * control plane (membership, single-speaker lock, presence, audit); live
 * audio rides one end-to-end-encrypted LiveKit room per channel.
 *
 *  - Listening: a SUBSCRIBE-only room per audible (joined + unmuted) channel.
 *    Remote audio tracks are attached to hidden <audio> elements.
 *  - Talking: once the server grants the speaker lock (signalled over the WS),
 *    we mint a short-lived PUBLISH token, reconnect that one channel's room
 *    with it (same identity, so the listen connection is replaced), and publish
 *    the mic. On release we tear the publish room down and resume listening.
 *
 * E2EE keys are derived per-channel server-side and delivered (base64) only to
 * authorised members; the SFU only ever relays ciphertext.
 */
export class RadioMedia {
  private listenRooms = new Map<string, Room>();
  private attachedEls = new Map<string, HTMLMediaElement[]>();
  private connecting = new Set<string>();
  private publishRoom: Room | null = null;
  private publishChannelId: string | null = null;
  private publishTrack: LocalAudioTrack | null = null;

  listenChannelIds(): string[] { return [...this.listenRooms.keys()]; }
  isListening(channelId: string): boolean { return this.listenRooms.has(channelId); }
  publishingChannelId(): string | null { return this.publishChannelId; }

  private async makeRoom(token: RadioToken): Promise<Room> {
    const keyProvider = new ExternalE2EEKeyProvider();
    await keyProvider.setKey(base64ToBytes(token.e2eeKey).buffer as ArrayBuffer);
    const worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
    const room = new Room({ e2ee: { keyProvider, worker } });
    await room.setE2EEEnabled(true);
    return room;
  }

  async ensureListen(channelId: string, token: RadioToken): Promise<void> {
    if (this.publishChannelId === channelId) return;
    if (this.listenRooms.has(channelId) || this.connecting.has(channelId)) return;
    this.connecting.add(channelId);
    try {
      const room = await this.makeRoom(token);
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach() as HTMLAudioElement;
        el.autoplay = true;
        el.style.display = "none";
        document.body.appendChild(el);
        el.play?.().catch(() => { /* autoplay gated until a user gesture */ });
        const arr = this.attachedEls.get(channelId) ?? [];
        arr.push(el);
        this.attachedEls.set(channelId, arr);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => { try { el.remove(); } catch { /* ignore */ } });
      });
      await room.connect(token.url, token.token);
      this.listenRooms.set(channelId, room);
    } finally {
      this.connecting.delete(channelId);
    }
  }

  async dropListen(channelId: string): Promise<void> {
    const room = this.listenRooms.get(channelId);
    this.listenRooms.delete(channelId);
    if (room) { try { await room.disconnect(); } catch { /* ignore */ } }
    const els = this.attachedEls.get(channelId);
    if (els) { els.forEach((el) => { try { el.remove(); } catch { /* ignore */ } }); this.attachedEls.delete(channelId); }
  }

  async startPublish(channelId: string, token: RadioToken, shouldAbort?: () => boolean): Promise<void> {
    // Same identity in the same room — drop the listen connection first or the
    // server would kick one of them.
    await this.dropListen(channelId);
    // Connecting a LiveKit room + creating a mic track is several awaits long.
    // If PTT is released mid-connect, stopPublish() runs and clears publishRoom/
    // publishTrack — but those are still null here, so without an abort poll the
    // in-flight room would publish audio AFTER release. Poll shouldAbort after
    // every async step and tear down the LOCAL room/track we created (not the
    // instance refs, which stopPublish may have already reset).
    const aborted = (): boolean => shouldAbort?.() ?? false;
    let room: Room | null = null;
    let track: LocalAudioTrack | null = null;
    try {
      room = await this.makeRoom(token);
      if (aborted()) throw new Error("aborted");
      await room.connect(token.url, token.token);
      if (aborted()) throw new Error("aborted");
      track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true });
      if (aborted()) throw new Error("aborted");
      await room.localParticipant.publishTrack(track);
      if (aborted()) throw new Error("aborted");
      this.publishRoom = room;
      this.publishChannelId = channelId;
      this.publishTrack = track;
    } catch (e) {
      // Disconnect the specific in-flight room/track we created here, regardless
      // of whether stopPublish() already nulled the instance fields.
      if (track) { try { track.stop(); } catch { /* ignore */ } }
      if (room) { try { await room.disconnect(); } catch { /* ignore */ } }
      throw e;
    }
  }

  async stopPublish(): Promise<void> {
    const room = this.publishRoom;
    const track = this.publishTrack;
    this.publishRoom = null;
    this.publishTrack = null;
    this.publishChannelId = null;
    if (room && track) { try { await room.localParticipant.unpublishTrack(track); } catch { /* ignore */ } }
    if (track) { try { track.stop(); } catch { /* ignore */ } }
    if (room) { try { await room.disconnect(); } catch { /* ignore */ } }
  }

  async teardown(): Promise<void> {
    await this.stopPublish();
    for (const id of this.listenChannelIds()) await this.dropListen(id);
  }
}

export default function RadioPage() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Record<string, { name: string; userId: string } | null>>({});
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [talkState, setTalkState] = useState<"idle" | "requesting" | "connecting" | "live">("idle");
  const [publishingChannelId, setPublishingChannelId] = useState<string | null>(null);
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<Channel["scope"]>("all_officers");
  const [newSiteId, setNewSiteId] = useState<string>("");
  const [wsReady, setWsReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline channel editing (name / scope / site).
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editScope, setEditScope] = useState<Channel["scope"]>("all_officers");
  const [editSiteId, setEditSiteId] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRef = useRef<RadioMedia | null>(null);
  const joinedRef = useRef<Set<string>>(new Set());

  // Mirror for use inside the WS message handler (which closes over initial state).
  const userIdRef = useRef<string | undefined>(user?.id);
  // Synchronous push-to-talk transmit-intent state machine. Owns the generation
  // counter + the intent that's set the instant PTT is pressed and cleared the
  // instant it's released, so a late 'speaking' echo arriving after release can
  // NEVER start a publish (React state / ref mirrors lag by a tick; this does
  // not). Unit-tested in radioTransmit.test.ts. See the memory note
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
  // Switching channels closes any open edit form (its fields belong to the old one).
  useEffect(() => { setEditing(false); }, [activeId]);

  // Channels the user explicitly left or muted. Persisted across the
  // session so a refresh respects their last preference.
  const [leftChannels, setLeftChannels] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("wcsg.radio.left") || "[]")); } catch { return new Set(); }
  });
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("wcsg.radio.muted") || "[]")); } catch { return new Set(); }
  });
  useEffect(() => { try { localStorage.setItem("wcsg.radio.left", JSON.stringify([...leftChannels])); } catch { /* ignore */ } }, [leftChannels]);
  useEffect(() => { try { localStorage.setItem("wcsg.radio.muted", JSON.stringify([...mutedChannels])); } catch { /* ignore */ } }, [mutedChannels]);

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

  // --- WS control plane (presence + speaker lock signalling) ---
  // Auto-reconnects with capped exponential backoff + jitter: a dropped control
  // socket should silently recover, not strand the page on "reload to retry".
  // The join effect re-runs on each reopen (joinedRef cleared on close), and the
  // LiveKit listen rooms reconnect themselves. We deliberately do NOT re-claim
  // the lock or re-publish on reconnect — a dropped speaker must press PTT again.
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    mediaRef.current = new RadioMedia();
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: number | undefined;

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
      reconnectTimer = window.setTimeout(connect, delay);
    };

    function connect(): void {
      if (cancelled) return;
      const ws = new WebSocket(buildRadioWsUrl(token!));
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
        if (typeof ev.data !== "string") return; // audio no longer rides this socket
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "speaking" && m.channelId) {
            setSpeakers((s) => ({ ...s, [m.channelId]: { name: m.speakerName, userId: m.speakerUserId } }));
            // The server confirmed WE hold the lock — mint a publish token and
            // go live. The controller gates on the synchronous transmit intent:
            // if PTT was already released, intent is null and a late echo is
            // ignored (returns null), so we never publish after release.
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

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
      wsRef.current = null;
      void mediaRef.current?.teardown();
      mediaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- join all visible non-archived channels (control plane) once WS is up ---
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

  // --- reconcile LiveKit listen rooms to the audible set ---
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
        if (cancelled) return;
        if (media.isListening(id)) continue;
        try {
          const tok = await fetchSubscribeToken(id);
          if (!tok || cancelled) continue;
          await media.ensureListen(id, tok);
        } catch (e) {
          // One channel failing to connect audio shouldn't break the others.
          console.warn("[radio] listen connect failed", id, e);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsReady, audioAvailable, channels, leftChannels, mutedChannels, publishingChannelId]);

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
    // token / connecting, bail out so we never transmit after the user let go.
    const aborted = (): boolean => transmitRef.current!.currentGen() !== gen;
    try {
      // Lock confirmed; mic isn't publishing yet — show "connecting" until it is.
      setTalkState("connecting");
      const tok = await fetchPublishToken(channelId);
      if (aborted()) return; // stopTalking already sent 'end' + cleaned up
      setPublishingChannelId(channelId);
      await mediaRef.current!.startPublish(channelId, tok, aborted);
      if (aborted()) { await mediaRef.current?.stopPublish(); setPublishingChannelId(null); return; }
      setTalkState("live");
    } catch (e) {
      // An intentional release-during-connect aborts startPublish with
      // Error("aborted"); stopTalking already reset state + sent 'end', so the
      // error is expected — clean up quietly without surfacing a scary message.
      if (aborted()) { setPublishingChannelId(null); return; }
      setError(isMicPermissionError(e)
        ? "Microphone blocked. Allow mic access for this site in your browser, then try again."
        : `Could not start transmitting: ${(e as Error).message}`);
      setTalkState("idle");
      setPublishingChannelId(null);
      wsRef.current?.send(JSON.stringify({ type: "end", channelId }));
    }
  }

  function startTalking(): void {
    if (!activeId || talkState !== "idle" || isSpeakingHere || someoneElseSpeaking) return;
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
    if (!transmitRef.current!.intent()) return;
    // The controller bumps the generation + clears intent FIRST (so any in-flight
    // beginPublish aborts itself and a late 'speaking' echo can't start a new
    // publish), then sends WS 'end' for the publishing/active channel.
    transmitRef.current!.stop(publishingChannelId, activeId);
    setTalkState("idle");
    await mediaRef.current?.stopPublish();
    setPublishingChannelId(null);
  }

  async function takeOverChannel(channelId: string): Promise<void> {
    try {
      await api(`/admin/radio/channels/${channelId}/preempt`, { method: "POST" });
      // The server broadcasts 'silent' to clear the floor; the ex-speaker's UI
      // resets. We don't auto-grab the lock — press PTT to talk.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not take over the channel.");
    }
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

  function openEdit(c: Channel): void {
    setEditName(c.name);
    setEditScope(c.scope);
    setEditSiteId(c.siteId ?? "");
    setEditing(true);
  }
  async function saveEdit(id: string): Promise<void> {
    if (!editName.trim()) return;
    try {
      const updated = await api<Channel>(`/admin/radio/channels/${id}`, {
        method: "PATCH",
        body: { name: editName.trim(), scope: editScope, siteId: editScope === "site" ? editSiteId : null },
      });
      setChannels((cs) => cs.map((c) => (c.id === id ? updated : c)));
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update channel");
    }
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
        <span className={`ml-2 text-xs px-2 py-0.5 rounded ${
          wsReady ? "bg-emerald-100 text-emerald-700"
          : reconnecting ? "bg-amber-100 text-amber-800"
          : "bg-zinc-100 text-zinc-600"
        }`}>
          {wsReady ? "Connected" : reconnecting ? "Reconnecting…" : "Connecting…"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Live push-to-talk radio. Hold the button to transmit; one speaker per channel.
        Audio is end-to-end encrypted and never recorded — only speaker and timing
        metadata are kept for audit.
      </p>

      {!audioAvailable && (
        <div className="mb-4 text-sm rounded border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2">
          Live audio is not configured on this server. Presence and the transmission
          log still work, but you can't hear or transmit until LiveKit is set up.
        </div>
      )}

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
                        {mutedChannels.has(c.id) && " · muted"}
                        {leftChannels.has(c.id) && " · left"}
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
            {activeChannel && !editing && (
              <>
                <div className="text-lg font-semibold">{activeChannel.name}</div>
                <div className="text-xs opacity-60 mb-4">
                  {activeChannel.scope === "site" ? `Site${activeChannel.siteName ? `: ${activeChannel.siteName}` : ""}` : activeChannel.scope}
                </div>

                {/* Prominent active-speaker banner */}
                <div className="mb-4 min-h-[44px] flex items-center justify-center">
                  {isSpeakingHere ? (
                    <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium bg-emerald-100 text-emerald-700">
                      <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" />
                      You are transmitting…
                    </span>
                  ) : someoneElseSpeaking ? (
                    <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium bg-sky-100 text-sky-700">
                      <Volume2 className="w-4 h-4 animate-pulse" />
                      {speakers[activeChannel.id]?.name} is transmitting…
                    </span>
                  ) : (
                    <span className="text-sm opacity-60">Channel idle</span>
                  )}
                </div>

                <button
                  onMouseDown={startTalking}
                  onMouseUp={() => { void stopTalking(); }}
                  onMouseLeave={() => { void stopTalking(); }}
                  onTouchStart={(e) => { e.preventDefault(); startTalking(); }}
                  onTouchEnd={(e) => { e.preventDefault(); void stopTalking(); }}
                  disabled={activeChannel.archivedAt !== null || someoneElseSpeaking || !wsReady || !audioAvailable}
                  className={`mx-auto w-40 h-40 rounded-full flex items-center justify-center text-white text-lg font-semibold transition-transform select-none ${
                    talkState === "live" ? "bg-emerald-600 scale-105 shadow-lg" :
                    talkState === "requesting" || talkState === "connecting" ? "bg-amber-500 scale-105 shadow-lg" :
                    someoneElseSpeaking ? "bg-zinc-400 cursor-not-allowed" :
                    "bg-rose-600 hover:bg-rose-700 active:scale-95"
                  }`}
                >
                  {someoneElseSpeaking ? <MicOff className="w-10 h-10" /> : <Mic className="w-10 h-10" />}
                </button>
                <div className="text-xs opacity-60 mt-3 min-h-[16px]">
                  {talkState === "requesting" ? "Requesting the floor…"
                    : talkState === "connecting" ? "Connecting your mic…"
                    : talkState === "live" ? "Live — release to stop."
                    : "Hold to talk — release to stop."}
                </div>

                {/* Admin take-over: clear the floor so this channel is free. */}
                {someoneElseSpeaking && (
                  <div className="mt-3">
                    <Button size="sm" variant="destructive" onClick={() => takeOverChannel(activeChannel.id)}>
                      <Hand className="w-3.5 h-3.5 mr-1" /> Take over
                    </Button>
                  </div>
                )}

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
                  <Button variant="outline" size="sm" onClick={() => openEdit(activeChannel)}>
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                  </Button>
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

            {activeChannel && editing && (
              <div className="text-left space-y-3 max-w-sm mx-auto">
                <div className="text-xs uppercase tracking-wider opacity-60 text-center">Edit channel</div>
                <label className="block text-xs font-medium opacity-70">Name</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full text-sm border rounded px-2 py-1 bg-background"
                />
                <label className="block text-xs font-medium opacity-70">Scope</label>
                <select value={editScope} onChange={(e) => setEditScope(e.target.value as Channel["scope"])} className="w-full text-sm border rounded px-2 py-1 bg-background">
                  <option value="all_officers">All officers</option>
                  <option value="global">Global (everyone)</option>
                  <option value="admins">Admins only</option>
                  <option value="site">Site-scoped</option>
                </select>
                {editScope === "site" && (
                  <>
                    <label className="block text-xs font-medium opacity-70">Site</label>
                    <select value={editSiteId} onChange={(e) => setEditSiteId(e.target.value)} className="w-full text-sm border rounded px-2 py-1 bg-background">
                      <option value="">Pick a site…</option>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </>
                )}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={() => saveEdit(activeChannel.id)} disabled={!editName.trim() || (editScope === "site" && !editSiteId)}>
                    <Check className="w-3.5 h-3.5 mr-1" /> Save
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                    <X className="w-3.5 h-3.5 mr-1" /> Cancel
                  </Button>
                </div>
              </div>
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
                  <div key={t.id} className="px-3 py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{t.speakerName ?? t.speakerUserId.slice(0, 8)}</div>
                      <div className="text-[11px] opacity-60">
                        {new Date(t.startedAt).toLocaleString()}
                        {t.endedReason && ` · ${t.endedReason}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs tabular-nums opacity-70">
                        {t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : "…"}
                      </span>
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
