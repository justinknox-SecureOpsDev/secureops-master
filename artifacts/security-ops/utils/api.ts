import { notifyUnauthorized } from "@workspace/api-client-react";

import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY } from "@/contexts/AuthContext";

/**
 * Hardcoded production origin for the canonical SecureOps Command deployment
 * (which also hosts the central org directory). Used as:
 *   - the native fallback before an organization has been selected,
 *   - the base for resolving org codes via the central directory, and
 *   - the legacy default org for clients upgrading from a single-tenant build
 *     (see contexts/OrgContext legacy migration).
 *
 * Multi-org builds override this at runtime via setRuntimeApiOrigin() once the
 * user resolves their organization code through the central directory.
 */
export const DEFAULT_NATIVE_ORIGIN = "https://secureops-command.replit.app";

/**
 * Native-only runtime override of the API base URL (full URL including the
 * trailing "/api"). Set once the selected organization is resolved. `null`
 * means "not yet selected" → fall back to DEFAULT_NATIVE_ORIGIN so a bundle
 * that lost its env vars still reaches a real API instead of "undefined".
 *
 * Web never uses this — it always talks to its own same origin.
 */
let runtimeApiBaseUrl: string | null = null;

function isReactNative(): boolean {
  // navigator.product === "ReactNative" tells us we are NOT in a real browser
  // even when window/location are polyfilled by Expo on web.
  return (
    typeof navigator !== "undefined" &&
    (navigator as { product?: string }).product === "ReactNative"
  );
}

/**
 * Point all subsequent native requests at a different backend.
 *
 * @param origin scheme + host only, NO path (e.g. "https://acme.example.app").
 *   Pass `null` to clear the override (falls back to DEFAULT_NATIVE_ORIGIN).
 *
 * Callers MUST pass an already-validated origin — see utils/orgConfig
 * `normalizeOrigin` (https-only in prod, origin-only, no path/query/fragment).
 */
export function setRuntimeApiOrigin(origin: string | null): void {
  runtimeApiBaseUrl = origin ? `${origin}/api` : null;
}

/**
 * Resolve the API base URL (including the trailing "/api") at CALL TIME.
 *
 *   - Web (real browser): same origin, so we are never cross-origin.
 *   - Native: the org-selected runtime origin, else the hardcoded WCSG prod
 *     origin (back-compat for the single-tenant build / OTA updates).
 *
 * Always resolved lazily so switching organizations takes effect immediately
 * across every consumer (REST, WS, PDF links, Orval client) with no re-wiring.
 */
export function getApiBaseUrl(): string {
  if (!isReactNative() && typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api`;
  }
  return runtimeApiBaseUrl ?? `${DEFAULT_NATIVE_ORIGIN}/api`;
}

export async function apiRequest(path: string, options: RequestInit = {}) {
  const token = await storage.get(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, { ...options, headers });
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
