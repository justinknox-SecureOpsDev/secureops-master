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
  // On web (browser), always use the same origin so requests are never
  // cross-origin — this works correctly in dev, staging, and production
  // without any env var, and avoids CORS rejections on the deployed API.
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api`;
  }
  // On native (React Native / Expo Go): EXPO_PUBLIC_API_BASE_URL takes
  // priority — set this to the deployed production URL so physical devices
  // can reach the API without going through the workspace-internal domain.
  const explicit = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
  if (explicit) {
    return /\/api$/.test(explicit) ? explicit : `${explicit}/api`;
  }
  // Fall back to EXPO_PUBLIC_DOMAIN injected by the dev workflow script.
  const domain = process.env.EXPO_PUBLIC_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (domain && domain !== "undefined") {
    return `https://${domain}/api`;
  }
  return "https://secureops.williamscouncilsecurity.com/api";
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
    const err = await res.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
