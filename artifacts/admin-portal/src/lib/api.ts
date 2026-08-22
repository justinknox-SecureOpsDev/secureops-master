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
 * Header the API reads for replay protection on writes that are not naturally
 * idempotent (create shift, roster an officer, approve a time entry).
 *
 * The server records the first response against the key; a later request
 * carrying the SAME key is answered from that record instead of running the
 * route again. Keys therefore belong to a *user intent*, not to a request —
 * see `useIdempotentIntent` in lib/idempotentIntent.ts.
 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * `code` the API stamps on the 409 that means "an identical keyed request is
 * still running" (see api-server/src/lib/idempotency.ts).
 *
 * Every other 409 a route can raise is a genuine refusal — already assigned,
 * already fully staffed, already paid — where nothing is happening and the
 * person has to change something. This one is the opposite: their write is in
 * progress at that very moment. Told apart by the code, never by the prose.
 */
export const IDEMPOTENT_IN_FLIGHT_CODE = "idempotency_in_flight";

/**
 * True when a rejected write is not a failure but an action still being saved:
 * the server has an identical keyed request in flight and has not finished it
 * yet.
 *
 * Surfaces must render this as pending, not as an error. "Could not assign
 * officer" next to a button, at the moment the assignment is committing, is
 * what sends someone off to press again or hunt for the record.
 */
export function isStillProcessing(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  return (err.data as { code?: unknown } | null)?.code === IDEMPOTENT_IN_FLIGHT_CODE;
}

/**
 * What to tell someone whose action is still being saved. Deliberately not
 * error-shaped: it states what is true (it is running, it was not repeated)
 * and asks for nothing.
 */
/**
 * True when the server definitively refused the request — a 4xx raised by the
 * route itself, which proves the write did not happen.
 *
 * Excludes the in-flight 409 (that write is running), 429 (a hosting-layer
 * throttle, not a verdict), and every 5xx or transport failure, where nothing
 * is proven: the write may well have committed before the answer was lost.
 * Only a definite refusal lets a caller declare an intent finished.
 */
export function isDefiniteRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError) || isStillProcessing(err)) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 429;
}

export const STILL_SAVING_MESSAGE =
  "Still saving — the server has not confirmed this yet, and it has not been repeated. It may still land. Trying again is safe: the same request cannot be applied twice.";

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

/**
 * How long a keyed write keeps re-joining an original request the server says
 * is still running.
 *
 * Re-sending the SAME key is not a retry in the risky sense: that request
 * never performs the work, it waits on the one already in flight and is then
 * answered from its record. So the only cost of joining again is time, and the
 * payoff is the real outcome instead of a false failure — which is how the
 * caller settles rather than being told to go and check the page.
 *
 * The budget is wall-clock rather than a count because the server blocks for
 * up to 15 s on each join: what matters is how long we are willing to wait on
 * one write, not how many round trips that takes. It is deliberately a ceiling
 * someone can sit through — a write still unfinished past it is pathological,
 * and the caller is told it is unconfirmed rather than left hanging.
 */
const IN_FLIGHT_JOIN_BUDGET_MS = 45_000;

/**
 * Pause before re-joining, so a write finishing right now is not raced, backing
 * off to a ceiling: when the server answers instantly (its own wait already
 * over) this stops us spinning through the budget in a burst of requests.
 */
function inFlightJoinDelayMs(join: number): number {
  return Math.min(500 * Math.pow(2, join), 5_000);
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
  init: Omit<RequestInit, "body"> & { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const { body, headers: rawHeaders, idempotencyKey, ...rest } = init;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((rawHeaders as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;

  const serializedBody =
    body === undefined || body === null
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);

  // Only retry safe (read-only) methods. POST/PUT/PATCH/DELETE responses with
  // 502/503 do not guarantee the mutation was not processed; retrying could
  // duplicate server-side actions.
  //
  // A write that carries an idempotency key is the exception: the server
  // replays the outcome it already recorded for that key, so a retry either
  // repeats the first attempt's answer or performs work the first attempt
  // never got to. That is the whole point of the key, so honour it here —
  // it is what makes a request interrupted by a restart or a cold start
  // recoverable without asking the user to go and check the page.
  const canRetry = isSafeMethod(rest.method) || Boolean(idempotencyKey);

  let res!: Response;
  let text = "";
  let data: unknown = null;

  // Two independent budgets: transient hosting-layer rejections (which say
  // nothing happened) and joins onto a write the server is still running
  // (which say something IS happening). Waiting out the second must not eat
  // the allowance for the first.
  let transientAttempts = 0;
  let inFlightJoins = 0;
  let joinDeadline = 0;

  for (;;) {
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

    // An identical keyed write is still running server-side. Go back and wait
    // on it: that request performs nothing, it is answered from the original's
    // record, so this settles on the real outcome instead of reporting a
    // failure for something that is mid-save.
    const stillProcessing =
      res.status === 409 &&
      (data as { code?: unknown } | null)?.code === IDEMPOTENT_IN_FLIGHT_CODE;
    if (stillProcessing) {
      if (!idempotencyKey) break;
      if (joinDeadline === 0) joinDeadline = Date.now() + IN_FLIGHT_JOIN_BUDGET_MS;
      if (Date.now() >= joinDeadline) break;
      await new Promise((r) => setTimeout(r, inFlightJoinDelayMs(inFlightJoins)));
      inFlightJoins += 1;
      continue;
    }

    if (!canRetry || !isRetryableStatus(res.status) || transientAttempts >= MAX_RETRIES) break;

    await new Promise((r) => setTimeout(r, retryDelayMs(transientAttempts, res)));
    transientAttempts += 1;
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
