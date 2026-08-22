import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { db, idempotencyKeysTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Replay protection for writes that are not naturally idempotent.
 *
 * Creating a shift, rostering an officer and approving a time entry all commit
 * on the way through. If the answer is lost after the route has run — a timed
 * out fetch, a dropped socket, a truncated body — the caller cannot tell
 * whether the work happened, and re-sending would double-book or double-pay.
 * Today the honest-but-useless answer to that is "go and check the page
 * yourself".
 *
 * A caller that supplies an idempotency key gets a better answer. The first
 * request through this middleware records its own response against the key;
 * a later request carrying the SAME key never reaches the handler at all — it
 * is answered with the recorded response. So a retry after an interrupted
 * request is safe by construction: it either replays the outcome the first
 * attempt already committed, or (if that attempt never got as far as
 * answering) performs the work for the first time.
 *
 * Deliberate properties:
 *   - Opt-in.      No key, no behaviour change — every existing caller is
 *                  unaffected.
 *   - Per-caller.  Keys are scoped to the actor and the exact route+resource,
 *                  so one user's key can never replay another's response, and
 *                  a key reused against a different shift is a different key.
 *   - Handler-blind. The route is untouched; there is still exactly one
 *                  implementation of "create a shift", with its own
 *                  permission, licence, headcount and audit behaviour.
 *   - Fails open on failures. A 4xx/5xx outcome is evicted rather than pinned,
 *                  so fixing the problem and retrying still works.
 *
 * Durable on purpose. The record lives in the database (`idempotency_keys`),
 * not in process memory, because the two things that used to erase it are
 * exactly the situations a retry has to survive: the server being redeployed
 * or crashing between the interrupted request and the retry, and the retry
 * landing on a second instance of the API. In both cases an in-memory record
 * was already gone, and the caller was back to "I cannot tell you whether that
 * went through". Process memory is still used, but only as a fast path for a
 * retry that arrives while the original is running in this same process; the
 * database is the authority.
 */

/** Standard header. `idempotencyKey` in the JSON body is accepted too. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
/** Set on a response that was replayed rather than performed. */
export const IDEMPOTENT_REPLAY_HEADER = "x-idempotent-replay";

/**
 * `code` on the 409 that says "an identical request under this key is still
 * running" — as opposed to the many ordinary 409s a route can raise ("already
 * assigned", "already fully staffed"), which really are refusals.
 *
 * The distinction matters to the caller: an ordinary 409 means nothing is
 * happening and the person must change something; this one means their write
 * is in progress right now. A client that cannot tell them apart has to show
 * the pessimistic one, which reads as "your action failed" at the exact moment
 * it is being saved. Machine-readable so nobody has to sniff the prose.
 */
export const IDEMPOTENT_IN_FLIGHT_CODE = "idempotency_in_flight";

export type IdempotentWriteOptions = {
  /**
   * Also stamp `idempotentReplay: true` into a replayed JSON object body, on
   * top of the header.
   *
   * The header is the signal for new callers. The payroll pay-run routes
   * carried their own replay protection before this middleware existed and
   * told their callers to read a body flag instead; they keep emitting it so
   * that consolidating on one mechanism changes nothing those callers see.
   */
  replayBodyFlag?: boolean;
};

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 200;

/**
 * How long a recorded outcome stays replayable. Matches the assistant's
 * pending-action TTL: long enough to cover a retry of an interrupted request,
 * short enough that a key can never resurrect a stale answer an hour later.
 *
 * It only ever applies to an entry that has ALREADY produced its outcome. A
 * write that is still running has no expiry — see `sweep`.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
let ttlMs = DEFAULT_TTL_MS;

/**
 * Ceiling on retained keys, so a pathological caller cannot grow the store
 * without bound.
 *
 * Reaching it does NOT evict anything — every retained key is either a write
 * still in flight or an outcome still replayable, and freeing either one is
 * how a retry ends up applying a change twice. A new keyed write is refused
 * instead. Refusing is safe (the route never runs); evicting is not.
 */
let maxEntries = 5000;

/**
 * How long a retry waits for an original request that is still running.
 *
 * It must wait rather than proceed: the whole point is that the work is never
 * done twice, and a request whose answer we have not seen yet may be one
 * instant away from committing. If it is still unresolved after this, the
 * caller is told so plainly instead of being handed a duplicate.
 */
const DEFAULT_IN_FLIGHT_WAIT_MS = 15_000;
let inFlightWaitMs = DEFAULT_IN_FLIGHT_WAIT_MS;

/** Test helper — shrink how long a duplicate waits before getting the 409. */
export function setIdempotencyInFlightWaitForTests(ms: number): void {
  inFlightWaitMs = ms;
}

/** Test helper — restore the production wait window. */
export function resetIdempotencyInFlightWaitForTests(): void {
  inFlightWaitMs = DEFAULT_IN_FLIGHT_WAIT_MS;
}

/**
 * How often a retry re-reads the store while waiting for a write running
 * somewhere else (another instance, or this instance before it restarted).
 * A retry inside this process does not poll at all — it waits on the original
 * request's own promise and is answered the instant it resolves.
 */
const POLL_INTERVAL_MS = 100;

/**
 * How the outcome of a completed write is persisted before its response goes
 * to the wire.
 *
 * This MUST fully succeed before anything — the response to the very caller
 * whose write this is, or an in-process replay promise for a concurrent
 * retry — is allowed to treat the outcome as recorded. A response sent (or a
 * replay promise resolved) ahead of the durable write would let this process
 * believe the claim is safely replayable while the database still shows it
 * unresolved; a restart an instant later would then answer a retry with
 * "still being processed" forever, never with the replay this process
 * already promised. Two answers to the same question is exactly the drift
 * this store exists to prevent.
 *
 * A handful of quick retries absorb a transient blip without holding the
 * response hostage for long — the underlying write just went through against
 * this same database, so a second failure back-to-back is not expected. If
 * every attempt fails, the claim is left unresolved (never released, never
 * spoken for) and the failure is surfaced rather than hidden: the caller
 * still receives their true result, but nothing tells any other caller — in
 * this process or a later one — that the write is safely replayable, because
 * it was never durably confirmed as such.
 */
const RECORD_PERSIST_ATTEMPTS = 3;
const RECORD_PERSIST_TIMEOUT_MS = 2_000;
const RECORD_PERSIST_BACKOFF_MS = 200;

/** Test seam: force the next N durable-persist attempts to fail, to prove a
 * caller is never told an outcome is replayable before it truly is. Pass
 * `Infinity` for "never succeeds". */
let forcedRecordOutcomeFailures = 0;
export function simulateRecordOutcomeFailuresForTests(times: number): void {
  forcedRecordOutcomeFailures = times;
}
export function clearRecordOutcomeFailuresForTests(): void {
  forcedRecordOutcomeFailures = 0;
}

type Recorded = { status: number; body: unknown };

/** The four parts a key is scoped by. Nothing else may widen or narrow it. */
export type IdempotencyScope = {
  /** Signed-in user id, or "anonymous". */
  actor: string;
  method: string;
  /** Request path without its query string. */
  path: string;
  /** The caller's own key. */
  key: string;
};

/**
 * Address of one record: a hash of actor + method + path + key.
 *
 * Exported so a test — or an operator clearing a stuck claim by hand — can
 * address exactly the same row the middleware would, without re-deriving the
 * scoping rule and getting it subtly wrong.
 */
export function idempotencyScopeHash(scope: IdempotencyScope): string {
  return createHash("sha256")
    .update([scope.actor, scope.method, scope.path, scope.key].join("\n"))
    .digest("hex");
}

// ── Durable store ──────────────────────────────────────────────────────────

/**
 * Drop keys that can no longer be needed — and ONLY those.
 *
 * An entry whose write has not produced an outcome yet is never removed, no
 * matter how old it is. That write may be one instant from committing, and
 * removing its key would turn the very next retry into a second execution.
 * A stuck write therefore holds its key, which is the safe direction to fail
 * in: a retry is told "still being processed" instead of being handed a
 * duplicate.
 */
async function sweep(now: number): Promise<void> {
  await db
    .delete(idempotencyKeysTable)
    .where(and(isNotNull(idempotencyKeysTable.status), lte(idempotencyKeysTable.expiresAt, new Date(now))));
}

async function countEntries(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(idempotencyKeysTable);
  return row?.n ?? 0;
}

/**
 * Take ownership of a key so this request — and no other, in this process or
 * any other — performs the work.
 *
 * The insert IS the claim: the primary key makes it an all-or-nothing race
 * that a second instance loses cleanly. An existing row is only ever taken
 * over when it holds an outcome that has already expired, which is the same
 * thing `sweep` would have deleted; an unresolved row is never stolen.
 */
async function claim(scope: IdempotencyScope, now: number): Promise<boolean> {
  const claimedAt = new Date(now);
  const expiresAt = new Date(now + ttlMs);
  const rows = await db
    .insert(idempotencyKeysTable)
    .values({
      scopeHash: idempotencyScopeHash(scope),
      actor: scope.actor,
      method: scope.method,
      path: scope.path,
      idempotencyKey: scope.key,
      claimedAt,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: idempotencyKeysTable.scopeHash,
      set: { status: null, body: null, resolvedAt: null, claimedAt, expiresAt },
      setWhere: and(
        isNotNull(idempotencyKeysTable.status),
        lte(idempotencyKeysTable.expiresAt, claimedAt),
      ),
    })
    .returning({ scopeHash: idempotencyKeysTable.scopeHash });
  return rows.length > 0;
}

type StoredEntry =
  | { resolved: false }
  | { resolved: true; recorded: Recorded };

async function readEntry(scope: IdempotencyScope, now: number): Promise<StoredEntry | null> {
  const [row] = await db
    .select({
      status: idempotencyKeysTable.status,
      body: idempotencyKeysTable.body,
      expiresAt: idempotencyKeysTable.expiresAt,
    })
    .from(idempotencyKeysTable)
    .where(eq(idempotencyKeysTable.scopeHash, idempotencyScopeHash(scope)));
  if (!row) return null;
  if (row.status === null) return { resolved: false };
  // A recorded outcome past its TTL is not replayable, whether or not this
  // instance has swept it yet.
  if (row.expiresAt.getTime() <= now) return null;
  return { resolved: true, recorded: { status: row.status, body: row.body } };
}

async function recordOutcome(scope: IdempotencyScope, outcome: Recorded, now: number): Promise<void> {
  if (forcedRecordOutcomeFailures > 0) {
    forcedRecordOutcomeFailures -= 1;
    throw new Error("[test] simulated durable outcome-persist failure");
  }
  // The claim's expiry was set when the write STARTED, so it can already be
  // in the past for a handler that ran long — the TTL is sized for how long
  // an outcome stays replayable, not for how long a write is allowed to
  // take. Refresh it to now + ttlMs here, at the moment there is finally an
  // outcome to make replayable, or a slow success would be treated as
  // already-expired the instant it lands and a retry would redo the write
  // instead of replaying it.
  await db
    .update(idempotencyKeysTable)
    .set({
      status: outcome.status,
      body: outcome.body ?? null,
      resolvedAt: new Date(now),
      expiresAt: new Date(now + ttlMs),
    })
    .where(eq(idempotencyKeysTable.scopeHash, idempotencyScopeHash(scope)));
}

async function releaseClaim(scope: IdempotencyScope): Promise<void> {
  await db
    .delete(idempotencyKeysTable)
    .where(eq(idempotencyKeysTable.scopeHash, idempotencyScopeHash(scope)));
}

// ── In-process fast path ───────────────────────────────────────────────────

/**
 * Writes running in THIS process right now, so a retry that arrives while the
 * original is still running is answered the moment it finishes instead of
 * polling the database for it. Purely an optimisation: everything here is also
 * in the durable store, which is what a retry after a restart — or on another
 * instance — reads.
 */
const inFlight = new Map<string, Promise<Recorded>>();

// ── Test seams ─────────────────────────────────────────────────────────────

/** Test helper — drops every recorded outcome, durable ones included. */
export async function clearIdempotencyStoreForTests(): Promise<void> {
  inFlight.clear();
  await db.delete(idempotencyKeysTable);
}

/**
 * Test helper — throw away everything this process is holding in memory, as a
 * restart or a redeploy would, WITHOUT touching the durable store. What
 * survives is exactly what a fresh instance would find.
 */
export function simulateProcessRestartForTests(): void {
  inFlight.clear();
}

/**
 * Test helper — shrink the capacity ceiling so the full-store path can be
 * exercised without issuing thousands of writes, and shorten the in-flight
 * wait so the "still being processed" path does not cost 15 seconds.
 */
export function setIdempotencyLimitsForTests(limits: {
  maxEntries?: number;
  inFlightWaitMs?: number;
  ttlMs?: number;
}): void {
  if (limits.maxEntries !== undefined) maxEntries = limits.maxEntries;
  if (limits.inFlightWaitMs !== undefined) inFlightWaitMs = limits.inFlightWaitMs;
  if (limits.ttlMs !== undefined) ttlMs = limits.ttlMs;
}

/** Test helper — restore production limits. */
export function resetIdempotencyLimitsForTests(): void {
  maxEntries = 5000;
  ttlMs = DEFAULT_TTL_MS;
  inFlightWaitMs = DEFAULT_IN_FLIGHT_WAIT_MS;
}

// ── Middleware ─────────────────────────────────────────────────────────────

function suppliedKey(req: Request): string | null {
  const header = req.headers[IDEMPOTENCY_HEADER];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  const body = req.body as { idempotencyKey?: unknown } | null | undefined;
  if (body && typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() !== "") {
    return body.idempotencyKey.trim();
  }
  return null;
}

function withTimeout(promise: Promise<Recorded>, ms: number): Promise<Recorded | "timeout" | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    // Never hold the process open just to expire a wait.
    timer.unref?.();
  });
  return Promise.race([promise.catch((): null => null), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Reject with `onTimeout()` if `promise` has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Persist a completed write's outcome, retrying a bounded number of times.
 * Returns whether it is now safe to tell ANYONE — this response, or a
 * same-process replay promise — that the outcome is durably recorded.
 *
 * Never resolves early on a timeout the way an in-memory fallback might: a
 * `false` here means the row is still unresolved in the database, and the
 * only honest thing left to do is leave it that way.
 */
async function persistOutcomeDurably(scope: IdempotencyScope, outcome: Recorded): Promise<boolean> {
  for (let attempt = 0; attempt < RECORD_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await withDeadline(
        recordOutcome(scope, outcome, Date.now()),
        RECORD_PERSIST_TIMEOUT_MS,
        () => new Error("[idempotency] durable outcome persist timed out"),
      );
      return true;
    } catch (err) {
      const isLastAttempt = attempt === RECORD_PERSIST_ATTEMPTS - 1;
      logger.error(
        { err, path: scope.path, attempt: attempt + 1, giving_up: isLastAttempt },
        "[idempotency] failed to persist a completed write's outcome",
      );
      if (!isLastAttempt) await sleep(RECORD_PERSIST_BACKOFF_MS * (attempt + 1));
    }
  }
  return false;
}

/** See `IdempotentWriteOptions.replayBodyFlag`. Arrays and non-objects pass through. */
function withReplayFlag(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), idempotentReplay: true };
}

type Existing =
  /** Nothing (or nothing usable) is held against this key. */
  | { kind: "none" }
  | { kind: "recorded"; recorded: Recorded }
  /** An identical write is still running and did not finish in time. */
  | { kind: "in_flight" };

/**
 * Find out what, if anything, this key already stands for — waiting, if an
 * identical write is still running, rather than starting a second copy of it.
 */
async function waitForExisting(
  hash: string,
  scope: IdempotencyScope,
  deadline: number,
): Promise<Existing> {
  const local = inFlight.get(hash);
  if (local) {
    // Running here: no need to poll, the original tells us directly.
    const settled = await withTimeout(local, Math.max(0, deadline - Date.now()));
    if (settled === "timeout") return { kind: "in_flight" };
    if (settled) return { kind: "recorded", recorded: settled };
    // The original produced nothing replayable — its claim is gone too.
    return { kind: "none" };
  }

  for (;;) {
    const stored = await readEntry(scope, Date.now());
    if (stored === null) return { kind: "none" };
    if (stored.resolved) return { kind: "recorded", recorded: stored.recorded };
    // Claimed by a request we cannot see: another instance, or this one before
    // it restarted. Either way it may be an instant from committing.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: "in_flight" };
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/**
 * Build the middleware. Mount AFTER the route's auth/permission guards (it
 * scopes keys by actor) and before the handler.
 *
 * Prefer the ready-made `idempotentWrite` below; take options only to keep a
 * route's existing replay signal working.
 */
export function idempotentWriteWith(options: IdempotentWriteOptions = {}): RequestHandler {
  return (req, res, next) => {
    const key = suppliedKey(req);
    if (key === null) {
      next();
      return;
    }
    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      res.status(400).json({
        error: "Bad Request",
        message: `An idempotency key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters.`,
      });
      return;
    }

    // Scope by actor AND by the exact resource being written, so a key can only
    // ever replay the response it belongs to.
    const path = (req.originalUrl || req.url || "").split("?")[0]!;
    const scope: IdempotencyScope = {
      actor: req.user?.userId ?? "anonymous",
      method: req.method,
      path,
      key,
    };
    const hash = idempotencyScopeHash(scope);

    void (async () => {
      let claimed = false;
      try {
        claimed = await claimOrAnswer(scope, hash, res, options);
      } catch (err) {
        // The durable store is the whole basis of the promise not to repeat this
        // write. Without it, running the handler would perform a write with none
        // of the protection its key asked for. Refuse instead — the route never
        // runs, so the answer is a definite "nothing was changed".
        logger.error({ err, path: scope.path }, "[idempotency] store unavailable — keyed write refused");
        res.status(503).json({
          error: "Service Unavailable",
          message:
            "This protected write could not be recorded, so it was not attempted. Nothing was changed — please try again in a moment.",
        });
        return;
      }
      // Outside the try: an error thrown by the route itself belongs to Express,
      // not to the store-unavailable branch above.
      if (claimed) next();
    })();
  };
}

/** The default middleware: header in, header out. */
export const idempotentWrite: RequestHandler = idempotentWriteWith();

/**
 * Decide what happens to a keyed request. Returns true when this request owns
 * the key and must run the handler; otherwise it has already been answered.
 */
async function claimOrAnswer(
  scope: IdempotencyScope,
  hash: string,
  res: Response,
  options: IdempotentWriteOptions,
): Promise<boolean> {
  await sweep(Date.now());
  const deadline = Date.now() + inFlightWaitMs;

  // Bounded: each turn either answers, starts the work, or loses the claim to
  // an identical request that got there first — in which case we go round and
  // wait on that one instead of running a second copy of the work.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await waitForExisting(hash, scope, deadline);

    if (existing.kind === "in_flight") {
      answerStillProcessing(res);
      return false;
    }
    if (existing.kind === "recorded") {
      replay(res, existing.recorded, options);
      return false;
    }

    if ((await countEntries()) >= maxEntries) {
      // Nothing here is safe to throw away: every retained key is a write
      // still running or an outcome still replayable. Running this one anyway
      // would mean performing a write without the replay protection its key
      // asked for. Refuse instead — the route never runs, so the answer is a
      // definite "nothing was changed".
      res.status(503).json({
        error: "Service Unavailable",
        message:
          "Too many protected writes are in flight, so this one was not attempted. Nothing was changed — please try again in a moment.",
      });
      return false;
    }

    if (await claim(scope, Date.now())) {
      recordOutcomeOf(scope, hash, res);
      return true;
    }
  }

  // Three times we found the key free and three times lost the claim. Whatever
  // holds it now is running the work; saying so is the one answer that cannot
  // duplicate it.
  answerStillProcessing(res);
  return false;
}

function answerStillProcessing(res: Response): void {
  // An identical request is still running. Answering it as a fresh write
  // would be the duplicate this whole mechanism exists to prevent.
  res.status(409).json({
    error: "Conflict",
    code: IDEMPOTENT_IN_FLIGHT_CODE,
    message:
      "An identical request with this key is still being processed. It has not been repeated — check whether it completed before sending it again.",
  });
}

function replay(res: Response, recorded: Recorded, options: IdempotentWriteOptions): void {
  res.setHeader(IDEMPOTENT_REPLAY_HEADER, "true");
  // The audit log records writes. This request performed none — it was
  // answered from the first one — so say so rather than letting the row
  // read as a second change.
  res.locals["auditMetadata"] = {
    ...((res.locals["auditMetadata"] as Record<string, unknown> | undefined) ?? {}),
    idempotentReplay: true,
  };
  res.status(recorded.status).json(options.replayBodyFlag ? withReplayFlag(recorded.body) : recorded.body);
}

/**
 * Capture this request's own answer against its claim.
 *
 * The outcome is written down BEFORE it goes to the wire. That ordering is
 * what makes an interrupted request recoverable: the socket may already be
 * gone, and the process may not survive the next second, but the answer a
 * retry needs is already durable.
 */
function recordOutcomeOf(
  scope: IdempotencyScope,
  hash: string,
  res: Response,
): void {
  let settle: ((r: Recorded) => void) | null = null;
  let abandon: (() => void) | null = null;
  const pending = new Promise<Recorded>((resolve, reject) => {
    settle = resolve;
    abandon = () => reject(new Error("no recorded outcome"));
  });
  // Nobody may be waiting when it is abandoned; that is not an error.
  pending.catch(() => {});
  inFlight.set(hash, pending);

  const forget = (): void => {
    if (inFlight.get(hash) === pending) inFlight.delete(hash);
  };

  let answered = false;
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (answered) return sendJson(body);
    answered = true;
    const outcome: Recorded = { status: res.statusCode, body };

    void (async () => {
      try {
        if (outcome.status >= 400) {
          // The attempt failed — the caller must stay free to fix the problem
          // and try again rather than be pinned to a dead outcome.
          abandon?.();
          await releaseClaim(scope).catch((err: unknown) => {
            logger.error({ err, path: scope.path }, "[idempotency] could not release a failed write's claim");
          });
        } else {
          // The write itself already happened. Whether THIS response, or any
          // in-process replay promise, may say so as "recorded" depends
          // entirely on whether the durable write actually succeeded — never
          // on a timeout standing in for it.
          const persisted = await persistOutcomeDurably(scope, outcome);
          if (persisted) {
            settle?.(outcome);
          } else {
            // The claim stays exactly as it is: unresolved, held, never
            // released. Nothing may treat this outcome as replayable — not a
            // concurrent same-process retry, and not a future one after a
            // restart — because the database itself cannot yet prove it. A
            // retry is answered (truthfully) with "still being processed"
            // for as long as that remains true. The ORIGINAL caller still
            // gets their real result below; only the promise of a safe
            // replay for everyone else is withheld.
            abandon?.();
          }
        }
      } catch (err) {
        logger.error({ err, path: scope.path }, "[idempotency] failed to finalise a keyed write");
      } finally {
        forget();
        sendJson(body);
      }
    })();

    return res;
  }) as typeof res.json;

  res.on("finish", () => {
    // Nothing replayable — the handler answered some other way — so the key
    // must not stay claimed against a response no retry could ever be given.
    if (answered) return;
    abandon?.();
    forget();
    void releaseClaim(scope).catch((err: unknown) => {
      logger.error({ err, path: scope.path }, "[idempotency] could not release an unrecorded claim");
    });
  });

  // Note: no eviction on "close". A client that hangs up mid-request is the
  // exact case this exists for — the handler is very likely still running
  // and about to commit, and dropping the entry there would let the retry
  // apply the change a second time.
}
