import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssignNearestDialog } from "@/components/AssignNearestDialog";

/**
 * Rostering an officer commits on the way through, so a second submit of the
 * same intent must not be a second assignment.
 *
 * This drives the real dialog through the real `api()` helper and stubs only
 * `fetch`, so what is asserted is what actually goes on the wire: the
 * Idempotency-Key header, and the fact that a repeated submit carries the key
 * the first one used. The stub answers the way the server's replay protection
 * does — the same key never reaches the route twice.
 */

const CANDIDATE = {
  userId: "officer-1",
  name: "Erin Officer",
  distanceMiles: 2.4,
  alreadyAssigned: false,
  conflictingShift: false,
  availabilityKnown: false,
  meetsLicense: true,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The body replay protection sends while an identical keyed request runs. */
const IN_FLIGHT_BODY = {
  error: "Conflict",
  code: "idempotency_in_flight",
  message: "An identical request with this key is still being processed.",
};

/** A stand-in API: replay protection in front of an assignment write. */
function makeApi({ turnAwayFirstAttempt = false }: { turnAwayFirstAttempt?: boolean } = {}) {
  /** Every assignment POST that reached the wire, with the key it carried. */
  const attempts: Array<string | null> = [];
  /** One row per time the write actually ran. */
  const assignments: Array<{ id: string; shiftId: string; employeeId: string }> = [];
  const recorded = new Map<string, { id: string; shiftId: string; employeeId: string }>();
  let turnAway = turnAwayFirstAttempt;

  const fetchStub = vi.fn(async (path: string, init: RequestInit = {}) => {
    if (path === "/api/dispatch/assign-nearest") {
      return jsonResponse(200, { topCandidate: CANDIDATE, candidates: [CANDIDATE], siteHasCoords: true });
    }

    const match = /^\/api\/shifts\/([^/]+)\/assignments$/.exec(path);
    if (match && (init.method ?? "GET").toUpperCase() === "POST") {
      const key = new Headers(init.headers).get("Idempotency-Key");
      attempts.push(key);

      if (turnAway) {
        // A hosting-layer rejection in front of the API: the route never ran.
        // Retry-After: 0 keeps the helper's back-off out of the test.
        turnAway = false;
        return jsonResponse(503, { message: "restarting" }, { "Retry-After": "0" });
      }
      if (key && recorded.has(key)) {
        // Answered from the record — the route is not run a second time.
        return jsonResponse(201, recorded.get(key), { "x-idempotent-replay": "true" });
      }

      const row = {
        id: `assignment-${assignments.length + 1}`,
        shiftId: match[1]!,
        employeeId: (JSON.parse(String(init.body)) as { employeeId: string }).employeeId,
      };
      assignments.push(row);
      if (key) recorded.set(key, row);
      return jsonResponse(201, row);
    }

    throw new Error(`unexpected request: ${path}`);
  });

  return { attempts, assignments, fetchStub };
}

function renderDialog(onAssigned: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssignNearestDialog shiftId="shift-1" open onOpenChange={vi.fn()} onAssigned={onAssigned} />
    </QueryClientProvider>,
  );
}

describe("rostering an officer twice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates one assignment and shows the original result, not an error", async () => {
    const { attempts, assignments, fetchStub } = makeApi();
    vi.stubGlobal("fetch", fetchStub);
    const onAssigned = vi.fn();
    renderDialog(onAssigned);

    const button = await screen.findByRole("button", { name: "Assign" });

    fireEvent.click(button);
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    // A second press a moment later — the same officer onto the same shift.
    fireEvent.click(button);
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(2));

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBeTruthy();
    expect(attempts[1]).toBe(attempts[0]);
    expect(assignments).toHaveLength(1);
    expect(screen.queryByText(/Could not assign officer/)).toBeNull();
    expect(screen.queryByText(/already assigned/i)).toBeNull();
  });

  it("reuses the key when the helper retries an attempt the hosting layer turned away", async () => {
    const { attempts, assignments, fetchStub } = makeApi({ turnAwayFirstAttempt: true });
    vi.stubGlobal("fetch", fetchStub);
    const onAssigned = vi.fn();
    renderDialog(onAssigned);

    const button = await screen.findByRole("button", { name: "Assign" });
    fireEvent.click(button);

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(assignments).toHaveLength(1);
  });
});

/**
 * When the original write is genuinely still running, the server answers 409
 * "still being processed". That is the assignment mid-flight, not a refusal —
 * so the dialog must stay pending and say so, never show a failure over a
 * write that is committing.
 */
describe("an assignment the server is still processing", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays pending while the write runs, then settles on its real outcome", async () => {
    const attempts: Array<string | null> = [];
    let assigned = false;
    const fetchStub = vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/dispatch/assign-nearest") {
        return jsonResponse(200, {
          topCandidate: { ...CANDIDATE, alreadyAssigned: assigned },
          candidates: [{ ...CANDIDATE, alreadyAssigned: assigned }],
          siteHasCoords: true,
        });
      }
      if (/^\/api\/shifts\/[^/]+\/assignments$/.test(path)) {
        attempts.push(new Headers(init.headers).get("Idempotency-Key"));
        // The original write is still running for the first two joins; then it
        // finishes and this key is answered from its record.
        if (attempts.length <= 2) return jsonResponse(409, IN_FLIGHT_BODY);
        assigned = true;
        return jsonResponse(201, { id: "assignment-1" }, { "x-idempotent-replay": "true" });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const onAssigned = vi.fn();
    renderDialog(onAssigned);

    fireEvent.click(await screen.findByRole("button", { name: "Assign" }));

    // While the server works, the action reads as saving — never as failed.
    await screen.findByRole("button", { name: "Saving…" });
    expect(screen.queryByText(/Could not assign officer/)).toBeNull();
    expect(screen.queryByText(/still being processed/i)).toBeNull();

    // …and it settles on what actually happened, with no further prompting.
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(screen.queryByText(/Could not assign officer/)).toBeNull();

    // Every join carried the original key, so nothing was assigned twice.
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts).size).toBe(1);
  }, 15_000);

  it("calls an unconfirmed write still saving, and leaves it retryable", async () => {
    // The server never confirms, so api() eventually spends its joining budget.
    // The dialog must say the write is unconfirmed rather than failed, and must
    // let the person press again — the held key can only replay, never assign
    // a second time.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const attempts: Array<string | null> = [];
      const fetchStub = vi.fn(async (path: string, init: RequestInit = {}) => {
        if (path === "/api/dispatch/assign-nearest") {
          return jsonResponse(200, { topCandidate: CANDIDATE, candidates: [CANDIDATE], siteHasCoords: true });
        }
        if (/^\/api\/shifts\/[^/]+\/assignments$/.test(path)) {
          attempts.push(new Headers(init.headers).get("Idempotency-Key"));
          return jsonResponse(409, IN_FLIGHT_BODY);
        }
        throw new Error(`unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchStub);
      const onAssigned = vi.fn();
      renderDialog(onAssigned);

      fireEvent.click(await screen.findByRole("button", { name: "Assign" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
      });

      const notice = screen.getByRole("status");
      expect(notice.textContent).toMatch(/still saving/i);
      // Not a failure, and not the server's own wording.
      expect(screen.queryByText(/Could not assign officer/)).toBeNull();
      expect(screen.queryByText(/still being processed/i)).toBeNull();

      // Pressing again is safe and allowed — that is how the person finds out.
      const button = screen.getByRole("button", { name: "Assign" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);

      // Nothing was claimed to have happened, and one intent = one key.
      expect(onAssigned).not.toHaveBeenCalled();
      expect(attempts.length).toBeGreaterThan(1);
      expect(new Set(attempts).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
