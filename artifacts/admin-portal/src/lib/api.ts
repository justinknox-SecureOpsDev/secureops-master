const TOKEN_KEY = "wcsg.adminToken";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message);
  }
}

/**
 * Fallback text for responses that carry no JSON body of our own.
 *
 * 429/502/503/504 are typically produced by the hosting layer in front of the
 * API (capacity, restart, cold start) rather than by a route, so the body is
 * empty or HTML and the raw status code is all the UI would otherwise have.
 */
function statusFallbackMessage(status: number): string {
  if (status === 429) {
    return "The server is busy right now and turned this request away. Wait a few seconds and try again.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "The server is temporarily unreachable (it may be restarting). Wait a few seconds and try again.";
  }
  return `Request failed (${status})`;
}

/**
 * Whether a response status is a transient hosting-layer rejection that may
 * be worth retrying for safe (read-only) requests.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Whether the HTTP method is safe/idempotent and therefore eligible for
 * automatic retry. POST/PUT/PATCH/DELETE are never retried automatically
 * because a 5xx or 429 response does not guarantee the mutation was not
 * processed — retrying could duplicate server-side actions.
 */
function isSafeMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/**
 * How long to wait before the next retry attempt (milliseconds).
 *
 * Supports both forms of the Retry-After header:
 *   - delta-seconds: a non-negative integer, e.g. "5"
 *   - HTTP-date:     a date string, e.g. "Wed, 04 Aug 2026 12:00:05 GMT"
 *
 * Falls back to exponential back-off capped at 8 s when the header is absent
 * or unparseable.
 */
function retryDelayMs(attempt: number, res: Response): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    // Try delta-seconds first (most common).
    const seconds = parseFloat(retryAfter);
    if (!isNaN(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
    // Try HTTP-date form.
    const ts = Date.parse(retryAfter);
    if (!isNaN(ts)) {
      const waitMs = ts - Date.now();
      if (waitMs > 0) return Math.min(waitMs, 10_000);
    }
  }
  // 1 s, 2 s, 4 s, 8 s …
  return Math.min(1_000 * Math.pow(2, attempt), 8_000);
}

const MAX_RETRIES = 3;

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
}

/**
 * Authenticated fetch that returns the raw Response — for blob/PDF/CSV
 * downloads and callers that need custom status handling (where the JSON-only
 * `api()` helper doesn't fit). Injects the current admin token and, exactly
 * like `api()`, fires the unauthorized handler when an *authenticated* request
 * is rejected with 401, so an expired/revoked session routes back to login
 * instead of dead-ending the screen. Pass the full path (e.g. `/api/...`).
 *
 * Retries transient hosting-layer errors automatically for safe (read-only)
 * methods (GET, HEAD, OPTIONS). Write methods are never retried automatically.
 */
export async function fetchWithAuth(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const canRetry = isSafeMethod(init.method);

  let res!: Response;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(path, { ...init, headers });
    if (res.status === 401 && token) {
      _unauthorizedHandler?.();
      return res;
    }
    if (!canRetry || !isRetryableStatus(res.status) || attempt === MAX_RETRIES) break;
    await new Promise((r) => setTimeout(r, retryDelayMs(attempt, res)));
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

  const serializedBody =
    body === undefined || body === null
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);

  // Only retry safe (read-only) methods. POST/PUT/PATCH/DELETE responses with
  // 502/503 do not guarantee the mutation was not processed; retrying could
  // duplicate server-side actions.
  const canRetry = isSafeMethod(rest.method);

  let res!: Response;
  let text = "";
  let data: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(`/api${path}`, {
      ...rest,
      headers,
      body: serializedBody,
    });

    text = await res.text();
    data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    // A 401 with a token means the session is expired — don't retry, log out.
    if (res.status === 401 && token) {
      _unauthorizedHandler?.();
      break;
    }

    if (!canRetry || !isRetryableStatus(res.status) || attempt === MAX_RETRIES) break;

    await new Promise((r) => setTimeout(r, retryDelayMs(attempt, res)));
  }

  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string })?.message ??
      (data as { error?: string })?.error ??
      statusFallbackMessage(res.status);
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}
