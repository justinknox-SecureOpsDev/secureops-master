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
  subscribeToRoom: (roomId: string, cb: (msg: ChatMessage) => void) => () => void;
}

const ChatContext = createContext<ChatContextValue>({
  connected: false,
  sendMessage: async () => {},
  subscribeToRoom: () => () => {},
});

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, Set<(msg: ChatMessage) => void>>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!token) return;
    const wsUrl = API_BASE_URL
      .replace(/^https?:\/\//, (m) => (m.startsWith("https") ? "wss://" : "ws://"))
      .replace(/\/api$/, "/api/ws");
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
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

  const sendMessage = useCallback(async (roomId: string, content: string) => {
    const { apiRequest } = await import("@/utils/api");
    await apiRequest(`/chat/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }, []);

  return (
    <ChatContext.Provider value={{ connected, sendMessage, subscribeToRoom }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
