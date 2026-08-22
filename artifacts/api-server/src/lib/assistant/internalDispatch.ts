import http from "node:http";
import { randomBytes } from "node:crypto";
import app from "../../app";
import { IDEMPOTENCY_HEADER, IDEMPOTENT_IN_FLIGHT_CODE, IDEMPOTENT_REPLAY_HEADER } from "../idempotency";
import { logger } from "../logger";

/**
 * Loopback dispatcher: how the assistant performs actions.
 *
 * The assistant has NO privileged path of its own. Every action it takes is an
 * ordinary HTTP request to this same server, on the same route the portal UI
 * calls, carrying the signed-in user's own Authorization header. That means
 * authentication, the role/permission matrix, per-site scoping, licence and
 * headcount guards, notification side effects and audit logging all apply
 * unchanged — and cannot drift away from the UI, because there is only one
 * implementation of each.
 *
 * Handler logic is never extracted, copied or reimplemented here.
 */

/**
 * Per-process secret proving a request really came from our own assistant
 * dispatcher. Used only to let the audit middleware trust the
 * assistant-origin marker; it grants no authority of its own (the user's
 * token still does all the authorising), it just stops an outside caller
 * from mislabelling their own writes as assistant-initiated.
 */
const INTERNAL_TOKEN = randomBytes(24).toString("hex");

export const ASSISTANT_ORIGIN_HEADER = "x-assistant-origin";
export const ASSISTANT_TOKEN_HEADER = "x-assistant-internal-token";

export function isTrustedAssistantOrigin(headerValue: unknown): boolean {
  return typeof headerValue === "string" && headerValue === INTERNAL_TOKEN;
}

let baseUrl: string | null = null;
let ephemeral: http.Server | null = null;
let ephemeralPromise: Promise<string> | null = null;

/**
 * Registered from index.ts once the real server is listening, so the
 * assistant reuses the process's own port instead of opening another one.
 */
export function setInternalBaseUrl(url: string): void {
  baseUrl = url;
}

/** Reset between tests. */
export async function closeInternalDispatch(): Promise<void> {
  baseUrl = null;
  ephemeralPromise = null;
  if (ephemeral) {
    await new Promise<void>((resolve) => ephemeral!.close(() => resolve()));
    ephemeral = null;
  }
}

/**
 * In a test process nothing has called listen(), so spin up a loopback-only
 * listener on an ephemeral port the first time it is needed. Bound to
 * 127.0.0.1 so it is never externally reachable.
 */
async function resolveBaseUrl(): Promise<string> {
  if (baseUrl) return baseUrl;
  if (ephemeralPromise) return ephemeralPromise;
  ephemeralPromise = new Promise<string>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Could not resolve an internal dispatch address"));
        return;
      }
      ephemeral = srv;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    srv.unref();
  });
  return ephemeralPromise;
}

export type InternalResponse = {
  status: number;
  ok: boolean;
  body: unknown;
  /** Human-readable failure text taken from the API's own error contract. */
  message: string | null;
  /**
   * The request was sent but no answer came back, so whether it committed is
   * genuinely unknown. Callers must not report this as "nothing happened".
   */
  unconfirmed?: boolean;
  /**
   * A first attempt was interrupted and this answer came from re-sending it
   * under the same idempotency key. The outcome is definite — it just took two
   * sends to learn it.
   */
  reconciled?: boolean;
  /**
   * The server recognised the idempotency key and returned the original
   * response without running the route again. Proof the work was performed
   * exactly once, by the attempt whose answer we lost.
   */
  replayed?: boolean;
};

/**
 * How many times one write may be sent.
 *
 * Two, and ONLY when the caller supplied an idempotency key — that key is what
 * makes the second send safe, because the route replays its recorded outcome
 * instead of performing the work again. One reconciling retry is enough to
 * turn "I don't know" into a definite answer; more would only lengthen the
 * wait a person is sitting through for no further certainty.
 */
const MAX_SEND_ATTEMPTS = 2;

/** Breathing room for an interrupted handler to finish committing. */
const RETRY_PAUSE_MS = 250;

export type DispatchOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  authorization: string;
  body?: unknown;
  /** Correlates the resulting audit row back to the assistant turn. */
  originRef?: string;
  /**
   * Makes this write re-sendable. The route records its outcome against the
   * key, so if the answer is lost we can send it again and either replay what
   * already committed or perform it for the first time — never twice. Without
   * a key an interrupted write stays honestly unknown.
   */
  idempotencyKey?: string;
};

export async function dispatchAsUser(opts: DispatchOptions): Promise<InternalResponse> {
  const attempts = opts.idempotencyKey ? MAX_SEND_ATTEMPTS : 1;

  let last: InternalResponse | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await sendOnce(opts);
    if (!res.unconfirmed) {
      // Definite either way. Say so, and note when it took a second send to
      // find out — the caller reports that instead of an unknown outcome.
      return attempt === 0 ? res : { ...res, reconciled: true };
    }
    last = res;
    if (attempt + 1 < attempts) {
      logger.warn(
        { path: opts.path, attempt: attempt + 1 },
        "[assistant] dispatch outcome lost — re-sending under the same idempotency key",
      );
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
  }
  return last!;
}

/**
 * Call one of this server's own routes as the signed-in user, once.
 *
 * `authorization` is the caller's verbatim Authorization header — the
 * assistant never mints a token, never elevates a role, and never bypasses a
 * middleware. If the user could not do this by clicking, this call fails the
 * same way, with the same message.
 */
async function sendOnce(opts: DispatchOptions): Promise<InternalResponse> {
  const base = await resolveBaseUrl();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: opts.authorization,
    [ASSISTANT_TOKEN_HEADER]: INTERNAL_TOKEN,
  };
  if (opts.originRef) headers[ASSISTANT_ORIGIN_HEADER] = opts.originRef;
  if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;

  // Everything from the moment the request leaves us until the body is fully
  // read is one uncertain window: a lost answer and a lost response body both
  // leave a possibly-committed change behind. Without an idempotency key these
  // writes are NOT repeatable, so the only safe report is "I don't know" — a
  // confident retry would double-book or double-approve. With a key, the
  // caller above turns that same uncertainty into a safe second send.
  //
  // "Nothing was changed" is reserved for failures proven to be pre-send: the
  // connection was never established.
  let res: Response;
  try {
    res = await fetch(`${base}${opts.path}`, {
      method: opts.method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const outcome = classifyDispatchFailure(err);
    logger.warn({ err, path: opts.path, unconfirmed: outcome.unconfirmed }, "[assistant] internal dispatch failed");
    return { status: 0, ok: false, body: null, ...outcome };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // Headers arrived, so the route ran. A truncated body tells us nothing
    // about whether it committed.
    logger.warn({ err, path: opts.path, status: res.status }, "[assistant] internal dispatch body read failed");
    return { status: 0, ok: false, body: null, unconfirmed: true, message: UNKNOWN_OUTCOME };
  }

  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  const message =
    (body as { message?: string } | null)?.message ??
    (body as { error?: string } | null)?.error ??
    null;

  const replayed = res.headers.get(IDEMPOTENT_REPLAY_HEADER) === "true";

  // The route refused to run a duplicate because an identical send is still in
  // flight. Nothing was applied twice, but we still do not know the outcome of
  // the original — that is exactly an unconfirmed result, not a refusal.
  if (res.status === 409 && looksLikeInFlightDuplicate(body)) {
    return { status: res.status, ok: false, body, unconfirmed: true, message: message ?? UNKNOWN_OUTCOME };
  }

  return { status: res.status, ok: res.ok, body, message, ...(replayed ? { replayed: true } : {}) };
}

function looksLikeInFlightDuplicate(body: unknown): boolean {
  if ((body as { code?: unknown } | null)?.code === IDEMPOTENT_IN_FLIGHT_CODE) return true;
  // Older shape, before the code was stamped on: fall back to the prose.
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.includes("still being processed");
}

/**
 * True only when we can show the request never reached the server: the
 * connection itself was refused or the host could not be resolved. A generic
 * network error, a timeout, or an abort are all ambiguous — fetch can report
 * those after the server has already accepted and committed the write.
 */
function isPreSendFailure(err: unknown): boolean {
  const codes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && codes.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export const UNKNOWN_OUTCOME =
  "The server did not give me a usable answer, so I cannot tell you whether that went through. Check the relevant page before trying again — repeating it could duplicate the change.";

const NEVER_SENT = "The action could not be sent to the server. Nothing was changed — please try again.";

/**
 * Decide what we may honestly claim about a failed dispatch. Exported so the
 * distinction is testable: the whole point is that only a proven pre-send
 * failure earns "nothing was changed".
 */
export function classifyDispatchFailure(err: unknown): { unconfirmed: boolean; message: string } {
  const neverSent = isPreSendFailure(err);
  return { unconfirmed: !neverSent, message: neverSent ? NEVER_SENT : UNKNOWN_OUTCOME };
}
