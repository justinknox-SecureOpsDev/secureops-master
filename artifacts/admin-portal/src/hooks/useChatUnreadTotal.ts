import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getToken } from "@/lib/api";

type UnreadCount = { roomId: string; otherUserId: string; unreadCount: number };

/**
 * Aggregate unread chat count across every room the current admin/dispatcher
 * can access (`scope=all` covers channels + DMs, mirroring the Chat sidebar).
 *
 * Shares the `["chat", "unread-counts"]` query key with the Chat page so the
 * cache (and the read-clearing invalidations it fires) stays in sync. Polls on
 * a 20s cadence and also opens a lightweight `/api/ws` subscription so the
 * badge updates in near-real-time from anywhere in the portal — not just when
 * the Chat page itself is mounted.
 */
export function useChatUnreadTotal(enabled: boolean): number {
  const qc = useQueryClient();

  const unread = useQuery<UnreadCount[]>({
    queryKey: ["chat", "unread-counts"],
    queryFn: () => api<UnreadCount[]>("/chat/unread-counts?scope=all"),
    refetchInterval: 20_000,
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    const token = getToken();
    if (!token) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      try { ws = new WebSocket(url); } catch { return; }
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 5000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (msg && (msg.type === "message" || msg.type === "chat:message")) {
            qc.invalidateQueries({ queryKey: ["chat", "unread-counts"] });
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
  }, [enabled, qc]);

  let total = 0;
  for (const c of unread.data ?? []) {
    if (c.unreadCount > 0) total += c.unreadCount;
  }
  return total;
}
