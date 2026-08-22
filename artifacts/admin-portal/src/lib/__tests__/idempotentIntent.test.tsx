import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIdempotentIntent } from "../idempotentIntent";

/**
 * A key is only worth sending if the client sends the SAME one for what the
 * person meant as one action. These tests stand a stripped-down copy of the
 * server's replay protection behind the hook and check the property that
 * matters: however many times one intent is submitted, the work happens once
 * and every caller sees the outcome of that one run.
 */

/**
 * Emulates `api-server/src/lib/idempotency.ts`: the first request under a key
 * runs the route and its answer is recorded; a later request under the same
 * key is answered from that record and never reaches the route.
 */
function makeServer() {
  /** One entry per time the route actually ran — the thing that must not double. */
  const performed: string[] = [];
  const recorded = new Map<string, Promise<{ id: string; of: string }>>();
  let nextId = 1;
  let loseNextAnswer = false;

  return {
    performed,
    /** The next attempt commits but its answer never reaches the caller. */
    loseTheNextAnswer() {
      loseNextAnswer = true;
    },
    async post(key: string, what: string): Promise<{ id: string; of: string }> {
      const replay = recorded.get(key);
      if (replay) return replay;

      const run = (async () => {
        performed.push(what);
        return { id: `row-${nextId++}`, of: what };
      })();
      // Recorded as the route answers, before it reaches the wire — which is
      // what makes an interrupted request replayable rather than unknown.
      recorded.set(key, run);

      if (loseNextAnswer) {
        loseNextAnswer = false;
        await run;
        throw new Error("connection lost");
      }
      return run;
    },
  };
}

describe("one idempotency key per user intent", () => {
  let clock = 1_700_000_000_000;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("performs one approval when the same intent is submitted twice at once", async () => {
    const { result } = renderHook(() => useIdempotentIntent());
    const server = makeServer();
    const intentId = "time-entry-decision:te-1:approved";
    const send = (key: string) => server.post(key, "approve te-1");

    // A double-click: both presses land before the first has answered.
    const [first, second] = await Promise.all([
      result.current.run(intentId, send),
      result.current.run(intentId, send),
    ]);

    expect(server.performed).toEqual(["approve te-1"]);
    expect(second).toEqual(first);
  });

  it("replays the original outcome when a lost answer is retried", async () => {
    const { result } = renderHook(() => useIdempotentIntent());
    const server = makeServer();
    const intentId = "shift-save:dialog-1";
    const send = (key: string) => server.post(key, "create shift");

    // The write commits; the answer never arrives.
    server.loseTheNextAnswer();
    await expect(result.current.run(intentId, send)).rejects.toThrow("connection lost");

    // The retry is the same intent, so it finds out what happened rather than
    // creating a second shift.
    const retried = await result.current.run(intentId, send);

    expect(server.performed).toEqual(["create shift"]);
    expect(retried).toEqual({ id: "row-1", of: "create shift" });
  });

  it("keeps two different actions apart", async () => {
    const { result } = renderHook(() => useIdempotentIntent());
    const server = makeServer();

    await result.current.run("assign:shift-1:officer-a", (k) => server.post(k, "assign a"));
    await result.current.run("assign:shift-1:officer-b", (k) => server.post(k, "assign b"));

    expect(server.performed).toEqual(["assign a", "assign b"]);
  });

  it("treats a deliberate repeat, once the first has settled, as its own write", async () => {
    const { result } = renderHook(() => useIdempotentIntent());
    const server = makeServer();
    const intentId = "shift-save:dialog-1";
    const send = (key: string) => server.post(key, "create shift");

    const first = await result.current.run(intentId, send);
    clock += 60_000;
    const second = await result.current.run(intentId, send);

    expect(server.performed).toEqual(["create shift", "create shift"]);
    expect(second.id).not.toBe(first.id);
  });
});
