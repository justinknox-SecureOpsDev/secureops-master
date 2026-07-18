import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Send, Loader2, Wifi, WifiOff, MessageCircle, Trash2, Plus } from "lucide-react";

type Room = { id: string; name: string; type: string };
type UnreadCount = { roomId: string; otherUserId: string; unreadCount: number };
type Message = {
  id: string;
  roomId: string;
  userId: string;
  content: string | null;
  createdAt: string;
  userName?: string | null;
  userRole?: string | null;
};

/**
 * Lightweight full-page chat for admins and dispatchers. Lists rooms
 * on the left, messages on the right, posts new messages and listens
 * on the shared `/api/ws` channel for real-time updates. Server-side
 * room ACL still applies on every fetch/post — this UI just renders
 * what the API hands back.
 */
export default function ChatPage() {
  const [location] = useLocation();
  const qc = useQueryClient();

  // Allow deep-linking from Dispatch: /chat?room=<id>
  const initialRoomId = useMemo(() => {
    const q = location.split("?")[1];
    if (!q) return "";
    const p = new URLSearchParams(q);
    return p.get("room") ?? "";
  }, [location]);

  const [roomId, setRoomId] = useState<string>(initialRoomId);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // New-channel dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("announcements");
  const [newLevel, setNewLevel] = useState("2");
  const [newCity, setNewCity] = useState("");

  const rooms = useQuery<Room[]>({
    queryKey: ["chat", "rooms"],
    queryFn: () => api<Room[]>("/chat/rooms"),
  });

  // Per-room unread badges for the sidebar. `scope=all` includes channels and
  // DMs the dispatcher can access, not just direct rooms. Polls so badges stay
  // fresh even when the WS misses a tick.
  const unread = useQuery<UnreadCount[]>({
    queryKey: ["chat", "unread-counts"],
    queryFn: () => api<UnreadCount[]>("/chat/unread-counts?scope=all"),
    refetchInterval: 20_000,
  });
  const unreadByRoom = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of unread.data ?? []) {
      if (c.unreadCount > 0) map.set(c.roomId, c.unreadCount);
    }
    return map;
  }, [unread.data]);

  useEffect(() => {
    if (!roomId && rooms.data && rooms.data.length > 0) {
      const ann = rooms.data.find((r) => r.type === "announcements") ?? rooms.data[0];
      setRoomId(ann.id);
    }
  }, [rooms.data, roomId]);

  const messages = useQuery<Message[]>({
    queryKey: ["chat", "messages", roomId],
    queryFn: () => api<Message[]>(`/chat/rooms/${roomId}/messages?limit=80`),
    enabled: !!roomId,
    refetchInterval: 20_000,
  });

  // Mark the open room read whenever it's selected or new messages land in
  // it, then refresh the Personnel unread badges so they clear immediately.
  const markRead = useMutation({
    mutationFn: (id: string) => api(`/chat/rooms/${id}/read`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personnel", "unread-counts"] });
      qc.invalidateQueries({ queryKey: ["chat", "unread-counts"] });
    },
  });
  useEffect(() => {
    if (!roomId || !messages.data) return;
    markRead.mutate(roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, messages.data]);

  // Admin-only: permanently delete a group channel (messages + memberships
  // cascade server-side). Direct messages are not deletable.
  const deleteRoom = useMutation({
    mutationFn: (id: string) => api(`/chat/rooms/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      if (id === roomId) setRoomId("");
      qc.invalidateQueries({ queryKey: ["chat", "rooms"] });
      qc.invalidateQueries({ queryKey: ["chat", "unread-counts"] });
    },
  });

  // Admin-only: create a new channel. License-level channels auto-add officers
  // by their license; city channels are request-to-join; elite are invite-only.
  const createRoom = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { name: newName.trim(), type: newType };
      if (newType === "license_level") payload.licenseLevel = Number(newLevel);
      if (newType === "city" && newCity.trim()) payload.city = newCity.trim();
      return api<Room>("/chat/rooms", { method: "POST", body: payload });
    },
    onSuccess: (room) => {
      setCreateOpen(false);
      setNewName("");
      setNewType("announcements");
      setNewLevel("2");
      setNewCity("");
      qc.invalidateQueries({ queryKey: ["chat", "rooms"] });
      if (room && (room as Room).id) setRoomId((room as Room).id);
    },
  });

  // Scroll to bottom when new messages land.
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.data]);

  // Real-time WS subscription. Reuses the same /api/ws channel chat
  // already broadcasts on; we just refetch the active room when a
  // message lands for it.
  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("connecting");
  useEffect(() => {
    const token = getToken();
    if (!token) { setWsState("closed"); return; }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      try { ws = new WebSocket(url); } catch { setWsState("closed"); return; }
      setWsState("connecting");
      ws.onopen = () => setWsState("open");
      ws.onclose = () => {
        setWsState("closed");
        if (!closed) retry = setTimeout(connect, 5000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          // Chat broadcasts include the roomId; only refetch if relevant.
          if (msg && (msg.type === "message" || msg.type === "chat:message")) {
            // Refresh sidebar badges for any incoming message...
            qc.invalidateQueries({ queryKey: ["chat", "unread-counts"] });
            // ...but only refetch the message list for the open room.
            if (msg.roomId === roomId) {
              qc.invalidateQueries({ queryKey: ["chat", "messages", roomId] });
            }
          }
        } catch { /* ignore */ }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ws && ws.readyState <= 1) ws.close();
    };
  }, [roomId, qc]);

  const send = useMutation({
    mutationFn: () => api(`/chat/rooms/${roomId}/messages`, {
      method: "POST",
      body: { content: text },
    }),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["chat", "messages", roomId] });
    },
  });

  const activeRoom = rooms.data?.find((r) => r.id === roomId);

  return (
    <div className="p-4 lg:p-6 h-full">
      <Card className="h-full flex flex-col">
        <CardHeader className="pb-3 flex-shrink-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="w-5 h-5 brand-gold" />
            Chat
            <span className="ml-auto flex items-center gap-2 text-xs opacity-60 font-normal">
              {wsState === "open" ? (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <Wifi className="w-3 h-3" /> live
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <WifiOff className="w-3 h-3" /> polling
                </span>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 grid grid-cols-[14rem_1fr]">
          <aside className="border-r overflow-y-auto p-2 space-y-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-start mb-1"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="w-4 h-4 mr-2" /> New channel
            </Button>
            {rooms.isLoading && <div className="text-xs opacity-60 p-2">Loading…</div>}
            {rooms.error && (
              <div className="text-xs text-red-700 p-2">
                {rooms.error instanceof Error ? rooms.error.message : "Could not load rooms."}
              </div>
            )}
            {rooms.data?.map((r) => {
              const n = r.id === roomId ? 0 : unreadByRoom.get(r.id) ?? 0;
              const selected = r.id === roomId;
              return (
                <div
                  key={r.id}
                  className={`group flex items-stretch rounded transition-colors ${
                    selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setRoomId(r.id)}
                    className="flex-1 min-w-0 text-left text-sm px-2 py-1.5"
                    aria-label={
                      n > 0
                        ? `${r.name ?? r.type}, ${n} unread message${n === 1 ? "" : "s"}`
                        : (r.name ?? r.type)
                    }
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`truncate ${n > 0 ? "font-semibold" : ""}`}>
                        {r.name ?? r.type}
                        {r.type === "announcements" && " 📣"}
                      </span>
                      {n > 0 && (
                        <span className="ml-auto flex-shrink-0 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-none">
                          {n > 99 ? "99+" : n}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] opacity-60 uppercase tracking-wide">{r.type}</div>
                  </button>
                  {r.type !== "direct" && (
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete the "${r.name ?? r.type}" channel?\n\nThis permanently removes the channel and all of its messages for everyone. This cannot be undone.`,
                          )
                        ) {
                          deleteRoom.mutate(r.id);
                        }
                      }}
                      disabled={deleteRoom.isPending}
                      className="flex-shrink-0 self-stretch px-2 text-muted-foreground opacity-0 transition-opacity hover:text-red-600 focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                      aria-label={`Delete ${r.name ?? r.type} channel`}
                      title="Delete channel"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </aside>

          <section className="flex flex-col min-h-0">
            <div className="px-4 py-2 border-b text-xs opacity-70">
              {activeRoom ? activeRoom.name ?? activeRoom.type : "Pick a channel"}
            </div>
            <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-1.5 text-sm">
              {messages.isLoading && <div className="opacity-60">Loading messages…</div>}
              {messages.error && (
                <div className="text-red-700">
                  {messages.error instanceof Error ? messages.error.message : "Could not load messages."}
                </div>
              )}
              {messages.data && messages.data.length === 0 && (
                <div className="opacity-60">No messages yet.</div>
              )}
              {messages.data?.map((m) => (
                <div key={m.id} className="leading-snug">
                  <span className="font-medium">{m.userName ?? "—"}</span>
                  {m.userRole && (
                    <span className="ml-1.5 text-[10px] uppercase opacity-60">{m.userRole}</span>
                  )}
                  <span className="opacity-50 text-xs ml-1.5">
                    {new Date(m.createdAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}
                  </span>
                  <div className="opacity-90 whitespace-pre-wrap">{m.content ?? ""}</div>
                </div>
              ))}
            </div>
            <div className="border-t p-3 space-y-2">
              <Textarea
                placeholder="Type a message…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                disabled={!roomId}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
                    e.preventDefault();
                    send.mutate();
                  }
                }}
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] opacity-60">⌘/Ctrl + Enter to send</span>
                <Button
                  onClick={() => send.mutate()}
                  disabled={!roomId || !text.trim() || send.isPending}
                  size="sm"
                >
                  {send.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
                  Send
                </Button>
              </div>
              {send.isError && (
                <div className="text-xs text-red-700">
                  {send.error instanceof Error ? send.error.message : "Failed to send."}
                </div>
              )}
            </div>
          </section>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(o) => { if (!createRoom.isPending) setCreateOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>Create a chat channel for your team.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ch-name">Name</Label>
              <Input
                id="ch-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Dispatch, Night Shift…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-type">Type</Label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger id="ch-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="announcements">Announcements — everyone can read and post</SelectItem>
                  <SelectItem value="ops">Ops — admins only</SelectItem>
                  <SelectItem value="license_level">License level — auto by officer license</SelectItem>
                  <SelectItem value="city">City / region — request to join</SelectItem>
                  <SelectItem value="elite">Elite — invite only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newType === "license_level" && (
              <div className="space-y-1.5">
                <Label htmlFor="ch-level">Minimum license level</Label>
                <Select value={newLevel} onValueChange={setNewLevel}>
                  <SelectTrigger id="ch-level"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">Level 2 — Unarmed and above</SelectItem>
                    <SelectItem value="3">Level 3 — Armed and above</SelectItem>
                    <SelectItem value="4">Level 4 — PPO</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {newType === "city" && (
              <div className="space-y-1.5">
                <Label htmlFor="ch-city">City (optional)</Label>
                <Input
                  id="ch-city"
                  value={newCity}
                  onChange={(e) => setNewCity(e.target.value)}
                  placeholder="e.g. Dallas"
                />
              </div>
            )}
            {createRoom.isError && (
              <div className="text-xs text-red-700">
                {createRoom.error instanceof Error ? createRoom.error.message : "Failed to create channel."}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={createRoom.isPending}>
              Cancel
            </Button>
            <Button onClick={() => createRoom.mutate()} disabled={!newName.trim() || createRoom.isPending}>
              {createRoom.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
