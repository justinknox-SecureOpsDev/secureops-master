import { notifyUnauthorized } from "@workspace/api-client-react";

import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY } from "@/contexts/AuthContext";

/**
 * Resolve the API origin in this priority:
 *   1. EXPO_PUBLIC_API_BASE_URL — explicit override (already includes scheme,
 *      e.g. "https://api.example.com" or "https://example.com/api").
 *   2. EXPO_PUBLIC_DOMAIN — bare host injected by the Expo dev script
 *      (= REPLIT_DEV_DOMAIN in dev). We add https:// and /api.
 *   3. Hardcoded production fallback so a bundle that lost its env vars
 *      (eg. an over-the-air JS update built without EXPO_PUBLIC_DOMAIN
 *      set) still talks to the real API instead of "https://undefined/api".
 */
function resolveApiBaseUrl(): string {
  const HARDCODED_PROD = "https://security-operations-suite.replit.app/api";
  // Web (browser) — use same origin so we are never cross-origin.
  // navigator.product === "ReactNative" tells us we are NOT in a real browser
  // even when window/location are polyfilled by Expo.
  const isReactNative =
    typeof navigator !== "undefined" &&
    (navigator as any).product === "ReactNative";
  if (!isReactNative && typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api`;
  }
  // Native — always return the hardcoded production URL. Env vars are
  // intentionally ignored here because OTA updates have repeatedly shipped
  // without EXPO_PUBLIC_* values inlined, breaking login.
  return HARDCODED_PROD;
}

export const API_BASE_URL = resolveApiBaseUrl();

export async function apiRequest(path: string, options: RequestInit = {}) {
  const token = await storage.get(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  } catch (e) {
    // React Native throws TypeError("Network request failed") for DNS failures,
    // bad URLs, and offline. Surface something the user can act on.
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Can't reach the server (${reason}). Check your internet connection and try again.`,
    );
  }
  if (!res.ok) {
    // An authenticated request was rejected — the session token is expired or
    // revoked. Let the app clear it and route back to login instead of leaving
    // every screen stuck on "failed".
    if (res.status === 401 && token) {
      notifyUnauthorized();
    }
    const err = await res.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
