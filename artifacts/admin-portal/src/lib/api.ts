import {
  setAuthTokenGetter,
  setUnauthorizedHandler as setGeneratedUnauthorizedHandler,
} from "@workspace/api-client-react";

const TOKEN_KEY = "wcsg.adminToken";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

// Wire the generated API client (orval hooks → customFetch) to the same
// localStorage-backed admin token used by api()/fetchWithAuth. Without this
// every generated hook (Dashboard, Analytics, SiteDetailPage, …) sends NO
// Authorization header and 401s. Module scope so it runs before any query.
setAuthTokenGetter(getToken);
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message);
  }
}

let _unauthorizedHandler: (() => void) | null = null;

/**
 * Register a handler invoked when an *authenticated* request (one that carried
 * a token) is rejected with HTTP 401 — i.e. the admin session is expired or
 * revoked. Lets the app clear the dead session and route back to the login
 * screen instead of dead-ending every page on "failed". Not fired for 401s on
 * requests with no token (e.g. a failed login). Pass null to clear.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  _unauthorizedHandler = handler;
  // Keep the generated client (orval hooks) in lockstep: a 401 on an
  // authenticated generated call must trigger the same logout-to-login flow.
  setGeneratedUnauthorizedHandler(handler);
}

/**
 * Authenticated fetch that returns the raw Response — for blob/PDF/CSV
 * downloads and callers that need custom status handling (where the JSON-only
 * `api()` helper doesn't fit). Injects the current admin token and, exactly
 * like `api()`, fires the unauthorized handler when an *authenticated* request
 * is rejected with 401, so an expired/revoked session routes back to login
 * instead of dead-ending the screen. Pass the full path (e.g. `/api/...`).
 */
export async function fetchWithAuth(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && token) {
    _unauthorizedHandler?.();
  }
  return res;
}

export async function api<T = unknown>(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const { body, headers: rawHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((rawHeaders as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers,
    body:
      body === undefined || body === null
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    if (res.status === 401 && token) {
      _unauthorizedHandler?.();
    }
    const msg =
      (data as { message?: string; error?: string })?.message ??
      (data as { error?: string })?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}
