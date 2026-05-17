import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
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
}

const ChatContext = createContext<ChatContextValue>({
  connected: false,
  sendMessage: async () => {},
  deleteMessage: async () => {},
  subscribeToRoom: () => () => {},
  subscribeToDeletes: () => () => {},
});

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, Set<(msg: ChatMessage) => void>>>(new Map());
  const deleteListenersRef = useRef<Map<string, Set<(messageId: string) => void>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!token) return;
    // API_BASE_URL is always https://… (set in utils/api.ts). Strip the
    // scheme and re-prepend the secure wss:// scheme literally so the
    // resulting URL is always TLS-encrypted.
    const host = API_BASE_URL.replace(/^https?:\/\//, "").replace(/\/api$/, "");
    const ws = new WebSocket(`wss://${host}/api/ws?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
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
        } else if (data.type === "chat_message_deleted" && data.roomId && data.messageId) {
          const listeners = deleteListenersRef.current.get(data.roomId);
          if (listeners) listeners.forEach((cb) => cb(data.messageId));
        }
      } catch { /* ignore */ }
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [token, connect]);

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
    <ChatContext.Provider value={{ connected, sendMessage, deleteMessage, subscribeToRoom, subscribeToDeletes }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
