import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useAuth } from "./AuthContext";
import { API_BASE_URL } from "@/utils/api";

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  content: string;
  createdAt: string;
  userName: string;
  userRole?: string;
}

interface ChatContextValue {
  connected: boolean;
  sendMessage: (roomId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  subscribeToRoom: (roomId: string, cb: (msg: ChatMessage) => void) => () => void;
  subscribeToDeletes: (roomId: string, cb: (messageId: string) => void) => () => void;
  /** Per-room unread counts for every accessible room (direct + channels). */
  unreadByRoom: Record<string, number>;
  /** Sum of all unread counts, for a tab-level badge. */
  totalUnread: number;
  /** Re-fetch unread counts from the server. */
  refreshUnread: () => Promise<void>;
  /** Mark a room read on the server and optimistically clear its badge. */
  markRoomRead: (roomId: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue>({
  connected: false,
  sendMessage: async () => {},
  deleteMessage: async () => {},
  subscribeToRoom: () => () => {},
  subscribeToDeletes: () => () => {},
  unreadByRoom: {},
  totalUnread: 0,
  refreshUnread: async () => {},
  markRoomRead: async () => {},
});

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, Set<(msg: ChatMessage) => void>>>(new Map());
  const deleteListenersRef = useRef<Map<string, Set<(messageId: string) => void>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});

  // Keep the latest user id in a ref so the long-lived WS handler can decide
  // whether an incoming message is "from someone else" without re-opening the
  // socket every time the user object changes identity.
  const userIdRef = useRef<string | undefined>(user?.id);
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

  const refreshUnread = useCallback(async () => {
    if (!token) return;
    try {
      const { apiRequest } = await import("@/utils/api");
      // scope=all so channels (#general, shift channels, city/elite) are
      // badged too, not just direct messages. The server enforces the same
      // per-room ACL as /chat/rooms for the non-direct rooms.
      const counts = (await apiRequest("/chat/unread-counts?scope=all")) as { roomId: string; unreadCount: number }[];
      const map: Record<string, number> = {};
      for (const c of counts) {
        if (c.unreadCount > 0) map[c.roomId] = c.unreadCount;
      }
      setUnreadByRoom(map);
    } catch { /* ignore — keep last known counts */ }
  }, [token]);

  // Stable ref to refreshUnread so the WS handler can call the latest version
  // without listing it as a dependency (which would churn the socket).
  const refreshUnreadRef = useRef(refreshUnread);
  useEffect(() => { refreshUnreadRef.current = refreshUnread; }, [refreshUnread]);

  const markRoomRead = useCallback(async (roomId: string) => {
    setUnreadByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
    if (!token) return;
    try {
      const { apiRequest } = await import("@/utils/api");
      await apiRequest(`/chat/rooms/${roomId}/read`, { method: "POST" });
    } catch { /* ignore — server watermark will reconcile on next refresh */ }
  }, [token]);

  const connect = useCallback(() => {
    if (!token) return;
    // API_BASE_URL is always https://… (set in utils/api.ts). Strip the
    // scheme and re-prepend the secure wss:// scheme literally so the
    // resulting URL is always TLS-encrypted.
    const host = API_BASE_URL.replace(/^https?:\/\//, "").replace(/\/api$/, "");
    const ws = new WebSocket(`wss://${host}/api/ws?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Pull authoritative unread counts whenever the socket (re)connects.
      void refreshUnreadRef.current();
    };
    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "chat_message" && data.message) {
          const msg = data.message as ChatMessage;
          const listeners = listenersRef.current.get(msg.roomId);
          if (listeners) listeners.forEach((cb) => cb(msg));
          // A message from someone else may bump an unread badge; re-fetch the
          // authoritative counts. The open room (if any) marks itself read.
          if (msg.userId !== userIdRef.current) void refreshUnreadRef.current();
        } else if (data.type === "chat_message_deleted" && data.roomId && data.messageId) {
          const listeners = deleteListenersRef.current.get(data.roomId);
          if (listeners) listeners.forEach((cb) => cb(data.messageId));
        }
      } catch { /* ignore */ }
    };
  }, [token]);

  useEffect(() => {
    if (!token) {
      setUnreadByRoom({});
      return;
    }
    connect();
    void refreshUnread();
    // Safety-net poll in case a WS message is missed (e.g. backgrounded app).
    const poll = setInterval(() => { void refreshUnread(); }, 30000);
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      clearInterval(poll);
    };
  }, [token, connect, refreshUnread]);

  const totalUnread = useMemo(
    () => Object.values(unreadByRoom).reduce((sum, n) => sum + n, 0),
    [unreadByRoom],
  );

  const subscribeToRoom = useCallback((roomId: string, cb: (msg: ChatMessage) => void) => {
    if (!listenersRef.current.has(roomId)) listenersRef.current.set(roomId, new Set());
    listenersRef.current.get(roomId)!.add(cb);
    return () => { listenersRef.current.get(roomId)?.delete(cb); };
  }, []);

  const subscribeToDeletes = useCallback((roomId: string, cb: (messageId: string) => void) => {
    if (!deleteListenersRef.current.has(roomId)) deleteListenersRef.current.set(roomId, new Set());
    deleteListenersRef.current.get(roomId)!.add(cb);
    return () => { deleteListenersRef.current.get(roomId)?.delete(cb); };
  }, []);

  const sendMessage = useCallback(async (roomId: string, content: string) => {
    const { apiRequest } = await import("@/utils/api");
    await apiRequest(`/chat/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }, []);

  const deleteMessage = useCallback(async (messageId: string) => {
    const { apiRequest } = await import("@/utils/api");
    await apiRequest(`/chat/messages/${messageId}`, { method: "DELETE" });
  }, []);

  return (
    <ChatContext.Provider
      value={{
        connected,
        sendMessage,
        deleteMessage,
        subscribeToRoom,
        subscribeToDeletes,
        unreadByRoom,
        totalUnread,
        refreshUnread,
        markRoomRead,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
