import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { api, fetchWithAuth, ApiError } from "../api";

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
