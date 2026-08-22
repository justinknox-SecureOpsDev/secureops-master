import { useCallback, useRef } from "react";

/**
 * One idempotency key per *user intent*.
 *
 * The API protects its non-idempotent writes (create shift, roster an officer,
 * approve a time entry) with an `Idempotency-Key` header: the first request
 * through does the work and its answer is recorded against the key; a later
 * request carrying the same key is answered from that record instead of
 * running the route a second time.
 *
 * That only helps if the client sends the SAME key for what the person meant
 * as one action. A key minted per request would make a double-click two
 * different writes again — two shifts, two assignments, a second approval.
 * So the key is minted when the user commits to an action and held against an
 * intent id (e.g. "assign officer X to shift Y") for as long as that action is
 * still settling.
 *
 * When the key is rotated:
 *   - After a success, briefly (see `KEY_HELD_AFTER_SUCCESS_MS`). Long enough
 *     that a click still in the pipeline replays the original result, short
 *     enough that a deliberate repeat a moment later is its own action.
 *   - Never after a failure. A failed attempt is exactly when we do not know
 *     whether the write landed — a dropped connection may have committed —
 *     and the retry must be able to find that out rather than risk applying
 *     it twice. (The server discards the recorded outcome of a failed request,
 *     so reusing the key after a genuine refusal simply performs the work.)
 *
 * "Still saving" rides on that same rule. When the server answers that an
 * identical request under this key is still running, `send` rejects and the
 * key stays held — so the surface can keep the action pending, and anything
 * that submits the intent again joins the original write instead of starting
 * a second one. See `isStillProcessing` in lib/api.ts.
 */

/** How long a completed intent keeps its key so a late duplicate replays. */
const KEY_HELD_AFTER_SUCCESS_MS = 2_000;

/** Never-expiring sentinel: an intent that has not produced an outcome yet. */
const UNSETTLED = Number.POSITIVE_INFINITY;

/**
 * A key the API will accept: it enforces a minimum length, so a short or empty
 * value is not usable. `crypto.randomUUID` is unavailable outside a secure
 * context, and this sits on a write path — fall back rather than throw.
 */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

type HeldKey = { key: string; reusableUntil: number };

export type IdempotentIntent = {
  /**
   * Run `send` under the key belonging to `intentId`, minting one if this is a
   * fresh intent and reusing the held key if the same intent is submitted
   * again while the first attempt is still settling.
   *
   * `intentId` must identify what the user meant to do, and must differ
   * between two things they could legitimately want to do in a row — e.g.
   * include the shift and the officer, not just "assign".
   */
  run<T>(intentId: string, send: (idempotencyKey: string) => Promise<T>): Promise<T>;
};

export function useIdempotentIntent(): IdempotentIntent {
  const held = useRef(new Map<string, HeldKey>());

  const run = useCallback(
    async <T,>(intentId: string, send: (idempotencyKey: string) => Promise<T>): Promise<T> => {
      const now = Date.now();
      // Drop keys whose intent has finished settling; the unsettled and the
      // failed ones (both UNSETTLED) are precisely the ones a retry needs.
      for (const [id, entry] of held.current) {
        if (entry.reusableUntil <= now) held.current.delete(id);
      }

      const existing = held.current.get(intentId);
      const key = existing ? existing.key : newIdempotencyKey();
      held.current.set(intentId, { key, reusableUntil: UNSETTLED });

      const result = await send(key);
      held.current.set(intentId, { key, reusableUntil: Date.now() + KEY_HELD_AFTER_SUCCESS_MS });
      return result;
    },
    [],
  );

  return { run };
}
