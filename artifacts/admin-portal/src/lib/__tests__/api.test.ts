import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  api,
  fetchWithAuth,
  ApiError,
  isStillProcessing,
  IDEMPOTENT_IN_FLIGHT_CODE,
} from "../api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh Response — important because Response.body can only be consumed once. */
function makeResponse(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Response {
  const bodyStr =
    body === null
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  return new Response(bodyStr, { status, headers });
}

/** Returns a fresh Response on every call — use with mockImplementation when the same status
 *  is returned across multiple fetch calls (re-using a single Response instance fails because
 *  the body stream can only be read once). */
function alwaysRespond(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
) {
  return () => Promise.resolve(makeResponse(status, body, headers));
}

// ---------------------------------------------------------------------------
// api() — retry behaviour
// ---------------------------------------------------------------------------

describe("api() retry behaviour", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns data immediately on a first-try success (GET)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const result = await api("/test");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("retries a GET on 429 and succeeds on the second attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const promise = api("/test");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
  });

  it("retries up to MAX_RETRIES times (3) for a persistent 429, then throws", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(429));

    // Attach the rejection handler before running timers so the settled
    // promise is not "unhandled" during the timer flush.
    const errCapture = api("/test").catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await errCapture;

    expect(err).toBeInstanceOf(ApiError);
    // 1 initial + 3 retries = 4 total calls.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("retries GET on 503 and succeeds on the third attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200, { value: 42 }));

    const promise = api("/test");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ value: 42 });
  });

  it("does NOT retry a POST on 429 (unsafe method — could duplicate server action)", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(429));

    // No timer needed: POST is rejected immediately (no back-off loop).
    await expect(
      api("/test", { method: "POST", body: { x: 1 } }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a PUT on 503", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(503));

    await expect(
      api("/test", { method: "PUT", body: {} }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a DELETE on 502", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(502));

    await expect(
      api("/test", { method: "DELETE" }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 400 error (non-retryable status)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(400, { message: "Bad" }));

    await expect(api("/test")).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 500 error (non-retryable status)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(500, { message: "Internal" }));

    await expect(api("/test")).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("respects a numeric Retry-After header on 429", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(429, null, { "Retry-After": "5" }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const promise = api("/test");
    // Advance past the Retry-After delay (5 000 ms).
    await vi.advanceTimersByTimeAsync(5_100);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("respects an HTTP-date Retry-After header on 429", async () => {
    const futureDate = new Date(Date.now() + 3_000).toUTCString();
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(429, null, { "Retry-After": futureDate }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const promise = api("/test");
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws ApiError with a helpful message on final 429 failure", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(429));

    // Capture before flushing timers so the settled rejection is handled.
    const errCapture = api("/test").catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await errCapture;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/busy/i);
  });
});

// ---------------------------------------------------------------------------
// api() — idempotency key
// ---------------------------------------------------------------------------

describe("api() idempotency key", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The header from the most recent fetch call. */
  function sentKey(call = 0): string | null {
    const init = vi.mocked(fetch).mock.calls[call]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers).get("Idempotency-Key");
  }

  it("puts the supplied key on the wire so the server can replay the write", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(201, { id: "s1" }));

    await api("/shifts", { method: "POST", body: {}, idempotencyKey: "intent-123456" });

    expect(sentKey()).toBe("intent-123456");
  });

  it("sends no key when none is supplied, leaving unkeyed callers untouched", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(201, { id: "s1" }));

    await api("/shifts", { method: "POST", body: {} });

    expect(sentKey()).toBeNull();
  });

  it("retries a keyed POST turned away by the hosting layer, reusing the key", async () => {
    // A 503 from in front of the API says nothing about whether the write
    // landed. With a key it does not have to: the retry either replays the
    // recorded answer or performs work that never happened.
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(201, { id: "s1" }));

    const promise = api("/shifts", { method: "POST", body: {}, idempotencyKey: "intent-123456" });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual({ id: "s1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentKey(0)).toBe("intent-123456");
    expect(sentKey(1)).toBe("intent-123456");
  });

  it("still refuses to retry an unkeyed POST on 503", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(503));

    await expect(api("/shifts", { method: "POST", body: {} })).rejects.toBeInstanceOf(ApiError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// api() — a write that is still being saved
// ---------------------------------------------------------------------------

/**
 * The server answers 409 when an identical keyed request is still running. That
 * is the opposite of the ordinary 409s a route raises ("already assigned"):
 * nothing was refused, the write is committing right now. Reporting it as a
 * failure next to the button is what sends someone off to press again.
 */
describe("api() on a write the server is still processing", () => {
  /** The body the replay-protection middleware sends while the original runs. */
  const inFlight = {
    error: "Conflict",
    code: IDEMPOTENT_IN_FLIGHT_CODE,
    message: "An identical request with this key is still being processed.",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function sentKey(call: number): string | null {
    const init = vi.mocked(fetch).mock.calls[call]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers).get("Idempotency-Key");
  }

  it("joins the original write and settles on its real outcome", async () => {
    // Re-sending the same key performs nothing — it waits on the request
    // already in flight and is answered from its record.
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(409, inFlight))
      .mockResolvedValueOnce(makeResponse(201, { id: "shift-1" }, { "x-idempotent-replay": "true" }));

    const promise = api("/shifts", { method: "POST", body: {}, idempotencyKey: "intent-123456" });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual({ id: "shift-1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    // The join must carry the SAME key, or it is a second write.
    expect(sentKey(1)).toBe("intent-123456");
  });

  it("keeps joining across several slow answers before settling", async () => {
    // The server can hold each join for its own wait and still not be done.
    // Give up too early and the caller reports "unconfirmed" for a write that
    // was about to land.
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(409, inFlight))
      .mockResolvedValueOnce(makeResponse(409, inFlight))
      .mockResolvedValueOnce(makeResponse(409, inFlight))
      .mockResolvedValueOnce(makeResponse(409, inFlight))
      .mockResolvedValueOnce(makeResponse(201, { id: "shift-1" }, { "x-idempotent-replay": "true" }));

    const promise = api("/shifts", { method: "POST", body: {}, idempotencyKey: "intent-123456" });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual({ id: "shift-1" });
    expect(fetch).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) expect(sentKey(i)).toBe("intent-123456");
  });

  it("reports a write that never finishes as still-saving, not as a failure", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(409, inFlight));

    const errCapture = api("/shifts", { method: "POST", body: {}, idempotencyKey: "intent-123456" })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await errCapture;

    expect(err).toBeInstanceOf(ApiError);
    expect(isStillProcessing(err)).toBe(true);

    // Bounded by a wall-clock budget, so the caller always regains control
    // rather than hanging — and the back-off keeps that from becoming a flood.
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(calls).toBeGreaterThan(4);
    expect(calls).toBeLessThan(40);
    // Every join carried the ORIGINAL key: nothing was written a second time.
    for (let i = 0; i < calls; i++) expect(sentKey(i)).toBe("intent-123456");
  });

  it("leaves an ordinary 409 a refusal — not retried, not 'still saving'", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(409, { error: "Conflict", message: "Officer is already assigned to this shift" }),
    );

    const err = await api("/shifts/shift-1/assignments", {
      method: "POST",
      body: {},
      idempotencyKey: "intent-123456",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(isStillProcessing(err)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not mistake other failures for a write in progress", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(500, { message: "Internal" }));

    const err = await api("/shifts", { method: "POST", body: {} }).catch((e) => e);

    expect(isStillProcessing(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchWithAuth() — retry behaviour
// ---------------------------------------------------------------------------

describe("fetchWithAuth() retry behaviour", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries GET on 429 and returns the successful response", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200));

    const promise = fetchWithAuth("/api/test");
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a POST on 429", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(429));

    const res = await fetchWithAuth("/api/test", { method: "POST" });
    expect(res.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and returns the last 503 response for GET", async () => {
    vi.mocked(fetch).mockImplementation(alwaysRespond(503));

    const promise = fetchWithAuth("/api/test");
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.status).toBe(503);
    // 1 initial + 3 retries = 4 total calls.
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
