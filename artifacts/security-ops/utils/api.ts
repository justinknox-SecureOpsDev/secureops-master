import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY } from "@/contexts/AuthContext";

export const API_BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;

export async function apiRequest(path: string, options: RequestInit = {}) {
  const token = await storage.get(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
