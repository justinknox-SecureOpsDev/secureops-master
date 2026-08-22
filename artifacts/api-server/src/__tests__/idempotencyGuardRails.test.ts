/**
 * Direct coverage of the three replay-protection answers that have no test
 * of their own: the in-flight 409, the at-capacity 503, and the bad-length
 * 400. `assistantIdempotentRetry.test.ts` proves the happy replay path (and
 * the assistant's use of it) through real business routes; this file proves
 * the middleware's own refusals in isolation, against a bare handler, so a
 * regression in any of them cannot hide behind route-specific behaviour.
 *
 * Each answer exists so a retry can never become a second payment:
 *   - 409  an identical keyed request is still running — waiting it out and
 *          then running it again would be the duplicate this exists to
 *          prevent, so it is refused instead, with a header a caller can
 *          tell apart from an ordinary business 409.
 *   - 503  the retained-key ceiling is reached — every retained key is a
 *          write in flight or an outcome still replayable, so nothing may be
 *          evicted to make room; the new write is refused, unattempted.
 *   - 400  a key of an unusable length — rejected before the handler runs,
 *          rather than silently accepted and never matched by a later retry.
 *
 * A bare Express app mounts only `idempotentWrite` in front of a
 * test-controlled handler, independent of any real route or the database.
 */

import express, { type Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_IN_FLIGHT_CODE,
  IDEMPOTENT_REPLAY_HEADER,
  clearIdempotencyStoreForTests,
  clearRecordOutcomeFailuresForTests,
  idempotentWrite,
  resetIdempotencyInFlightWaitForTests,
  resetIdempotencyLimitsForTests,
  simulateProcessRestartForTests,
  simulateRecordOutcomeFailuresForTests,
  setIdempotencyInFlightWaitForTests,
  setIdempotencyLimitsForTests,
} from "../lib/idempotency";

function newKey(): string {
  return `test-${randomUUID()}`;
}

/** A handler that only answers once told to, and counts how often it ran. */
function buildGatedApp(): {
  app: Express;
  calls: () => number;
  waitForStart: () => Promise<void>;
  release: () => void;
} {
  const app = express();
  app.use(express.json());
  let calls = 0;
  let startedResolve: (() => void) | null = null;
  let started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let releaseFn: (() => void) | null = null;
  app.post("/pay", idempotentWrite, async (_req, res) => {
    calls += 1;
    startedResolve?.();
    await new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    res.status(200).json({ paid: true });
  });
  return {
    app,
    calls: () => calls,
    waitForStart: () => started,
    release: () => {
      releaseFn?.();
      // Reset for a possible second in-flight round within the same test.
      started = new Promise((resolve) => {
        startedResolve = resolve;
      });
    },
  };
}

/** A handler that answers immediately and counts how often it ran. */
function buildCountingApp(): { app: Express; calls: () => number } {
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post("/pay", idempotentWrite, (_req, res) => {
    calls += 1;
    res.status(200).json({ paid: true, at: calls });
  });
  return { app, calls: () => calls };
}

afterEach(async () => {
  await clearIdempotencyStoreForTests();
  resetIdempotencyLimitsForTests();
  resetIdempotencyInFlightWaitForTests();
  clearRecordOutcomeFailuresForTests();
});

describe("a duplicate arriving while the first write is still running", () => {
  it("is refused with a 'not repeated' 409 instead of running the handler again", async () => {
    // Keep the wait short so the test does not spend 15 real seconds getting
    // there — the wait itself is not what this test is proving.
    setIdempotencyInFlightWaitForTests(150);
    const { app, calls, waitForStart, release } = buildGatedApp();
    const key = newKey();

    // supertest/superagent requests are lazy — they do not go out over the
    // wire until awaited or `.then`-ed. Kick this one off explicitly so it is
    // genuinely in flight (not merely constructed) before the retry is sent.
    const firstReq = request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({});
    const first = firstReq.then((r) => r);
    // Do not race the two requests: wait until the first has genuinely
    // reached the handler and is holding it open before sending the retry.
    await waitForStart();

    const duplicate = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({}).expect(409);
    expect(duplicate.body.code).toBe(IDEMPOTENT_IN_FLIGHT_CODE);
    expect(duplicate.body.message).toMatch(/not been repeated/i);
    // The refusal happened without ever invoking the handler a second time.
    expect(calls()).toBe(1);

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.paid).toBe(true);
  });
});

describe("a new keyed write when no key can safely be retained", () => {
  it("is refused with a 503 — nothing evicted, handler never runs", async () => {
    setIdempotencyLimitsForTests({ maxEntries: 1 });
    const { app, calls } = buildCountingApp();

    const keptKey = newKey();
    const first = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, keptKey).send({}).expect(200);
    expect(calls()).toBe(1);

    const refused = await request(app)
      .post("/pay")
      .set(IDEMPOTENCY_HEADER, newKey())
      .send({})
      .expect(503);
    expect(refused.body.message).toMatch(/nothing was changed/i);
    // The refused write never reached the handler.
    expect(calls()).toBe(1);

    // Proof nothing was evicted to make room: the first key still replays its
    // original outcome rather than running the handler a second time.
    const replay = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, keptKey).send({}).expect(200);
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(replay.body.at).toBe(first.body.at);
    expect(calls()).toBe(1);
  });
});

describe("a completed write whose durable outcome persist keeps failing", () => {
  it("answers the original caller honestly but never tells anyone the outcome is safely replayable", async () => {
    // Keep both waits short — neither the retry-backoff nor the in-flight
    // wait is what this test is proving.
    setIdempotencyInFlightWaitForTests(150);
    const { app, calls } = buildCountingApp();
    const key = newKey();

    // The write itself succeeds every time; only persisting its outcome to
    // the durable store fails, every attempt, forever.
    simulateRecordOutcomeFailuresForTests(Infinity);
    const first = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(first.body.paid).toBe(true);
    expect(calls()).toBe(1);

    // Same process, same key, immediately after: because the durable write
    // was never confirmed, this must NOT be answered from the in-process
    // fast path as a replay — that would be telling this caller something
    // the database itself cannot back up.
    const stillOpenSameProcess = await request(app)
      .post("/pay")
      .set(IDEMPOTENCY_HEADER, key)
      .send({})
      .expect(409);
    expect(stillOpenSameProcess.body.code).toBe(IDEMPOTENT_IN_FLIGHT_CODE);
    expect(calls()).toBe(1);

    // Now let persistence succeed again, but simulate the process restarting
    // — throwing away everything held in memory, exactly like a redeploy
    // between the interrupted request and its retry. The durable row is
    // STILL unresolved (it never got persisted), so a retry after the
    // "restart" must see the identical honest answer: never a duplicate
    // execution of the handler, and never a false replay of an outcome the
    // database never actually recorded.
    clearRecordOutcomeFailuresForTests();
    simulateProcessRestartForTests();
    const stillOpenAfterRestart = await request(app)
      .post("/pay")
      .set(IDEMPOTENCY_HEADER, key)
      .send({})
      .expect(409);
    expect(stillOpenAfterRestart.body.code).toBe(IDEMPOTENT_IN_FLIGHT_CODE);
    expect(calls()).toBe(1);
  });
});

describe("a claim whose original expiry lapsed while its handler was still running", () => {
  it("refreshes the expiry when the outcome is recorded, so a retry replays instead of re-running the handler", async () => {
    // The claim's expiry is set when the write STARTS. Shrink the TTL well
    // below how long this handler will legitimately take, standing in for a
    // real write that simply runs longer than the TTL — the same situation a
    // slow report or a heavy roster change can land in.
    setIdempotencyLimitsForTests({ ttlMs: 100 });
    const { app, calls, waitForStart, release } = buildGatedApp();
    const key = newKey();

    const firstReq = request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({});
    const first = firstReq.then((r) => r);
    await waitForStart();

    // Hold the handler open past the claim's original expiry before it
    // finishes and records its outcome.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(calls()).toBe(1);

    // If the recorded outcome had kept the stale expiry from claim time, it
    // would already read as expired the instant it landed — sweepable, and a
    // retry would rerun the handler instead of replaying it. It must replay.
    const retry = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(retry.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(calls()).toBe(1);
  });
});

describe("an outcome that has aged past its TTL", () => {
  it("is swept so a later request with the same key performs the work again instead of replaying it", async () => {
    setIdempotencyLimitsForTests({ ttlMs: 50 });
    const { app, calls } = buildCountingApp();
    const key = newKey();

    const first = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(calls()).toBe(1);

    // Well within the TTL, the same key still replays the recorded outcome.
    const stillFresh = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(stillFresh.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(stillFresh.body.at).toBe(first.body.at);
    expect(calls()).toBe(1);

    // Wait past the TTL — long enough that this is not a timing flake.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The key is no longer replayable: the handler runs again, and the new
    // response is NOT stamped as a replay.
    const afterTtl = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(afterTtl.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(afterTtl.body.at).not.toBe(first.body.at);
    expect(calls()).toBe(2);
  });
});

describe("a retained-key ceiling reached only by entries that have since expired", () => {
  it("is actually freed by the sweep, not merely re-claimable under the same key", async () => {
    setIdempotencyLimitsForTests({ ttlMs: 50, maxEntries: 1 });
    const { app, calls } = buildCountingApp();
    const firstKey = newKey();

    await request(app).post("/pay").set(IDEMPOTENCY_HEADER, firstKey).send({}).expect(200);
    expect(calls()).toBe(1);

    // Still within the TTL: the ceiling is exhausted, so an unrelated new key
    // is refused rather than evicting the still-replayable entry.
    const stillCapped = await request(app)
      .post("/pay")
      .set(IDEMPOTENCY_HEADER, newKey())
      .send({})
      .expect(503);
    expect(stillCapped.body.message).toMatch(/nothing was changed/i);
    expect(calls()).toBe(1);

    // Wait past the TTL.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // A brand-new, unrelated key can now claim the sole slot. If the expired
    // entry were merely capped — still counted, just no longer replayable —
    // this would still be refused by the same 503; succeeding proves `sweep`
    // actually deleted the row and freed real capacity, not just marked it
    // stale.
    const secondKey = newKey();
    const afterSweep = await request(app).post("/pay").set(IDEMPOTENCY_HEADER, secondKey).send({}).expect(200);
    expect(afterSweep.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(calls()).toBe(2);
  });
});

describe("a handler that answers without ever calling res.json", () => {
  it("leaves nothing pinned in the store afterward", async () => {
    // The ceiling is the only externally visible proxy for "is a row still
    // retained" — there is no other way to inspect the store from outside.
    setIdempotencyLimitsForTests({ maxEntries: 1 });
    const app = express();
    app.use(express.json());
    let calls = 0;
    app.post("/text", idempotentWrite, (_req, res) => {
      calls += 1;
      // Deliberately res.send (a plain string, not an object) rather than
      // res.json — the middleware only patches res.json, so this is exactly
      // the "answered some other way" case the res.on("finish") cleanup
      // exists for.
      res.status(200).send("plain text, not JSON");
    });

    // The release runs from a `res.on("finish")` listener that fires once the
    // response has gone out, fire-and-forget (it does not hold the response
    // open) — so give it a moment to land before relying on it, the same way
    // a real retry arriving immediately after would not be guaranteed to see
    // it either.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    const key = newKey();
    const first = await request(app).post("/text").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(first.text).toBe("plain text, not JSON");
    expect(calls).toBe(1);
    await settle();

    // Proof the claim was released rather than left pinned: with the ceiling
    // at 1, a totally unrelated key can only succeed if the first response's
    // "finish" cleanup actually deleted its row.
    const otherKey = newKey();
    const second = await request(app).post("/text").set(IDEMPOTENCY_HEADER, otherKey).send({}).expect(200);
    expect(second.text).toBe("plain text, not JSON");
    expect(calls).toBe(2);
    await settle();

    // The original key itself is free to be reused too, not merely capped —
    // running the handler again rather than replaying a nonexistent outcome.
    const reused = await request(app).post("/text").set(IDEMPOTENCY_HEADER, key).send({}).expect(200);
    expect(reused.text).toBe("plain text, not JSON");
    expect(calls).toBe(3);
  });
});

describe("a key of an unusable length", () => {
  it("rejects both a too-short and a too-long key before the handler runs", async () => {
    const { app, calls } = buildCountingApp();

    const tooShort = await request(app)
      .post("/pay")
      .set(IDEMPOTENCY_HEADER, "abc")
      .send({})
      .expect(400);
    expect(tooShort.body.message).toMatch(/idempotency key/i);

    const tooLong = await request(app)
      .post("/pay")
      .set(IDEMPOTENCY_HEADER, "x".repeat(201))
      .send({})
      .expect(400);
    expect(tooLong.body.message).toMatch(/idempotency key/i);

    expect(calls()).toBe(0);
  });
});
