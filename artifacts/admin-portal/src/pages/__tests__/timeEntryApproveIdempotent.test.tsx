import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Approving a time entry on a site's page releases its hours to payroll AND to
 * the client invoice, and the route re-runs on an entry that already has a
 * decision (it re-stamps approvedAt and re-rolls the invoice) — so a second
 * approval is a real duplicate, not a harmless no-op. The only thing standing
 * between a repeated press and that duplicate is the Idempotency-Key the page
 * sends.
 *
 * The helper that mints the key and the roster dialog that uses it are covered
 * elsewhere; nothing drove the actual Approve button, so an edit to this page
 * could drop the key with every test still green. This mounts the real Site
 * Detail page through the real `api()` helper and stubs only `fetch`, so what
 * is asserted is what goes on the wire.
 *
 * The stub answers the way the server does: keys are scoped to the route and
 * the resource, a repeat of a recorded key never reaches the handler, a key
 * shorter than the server's minimum is refused, and the route itself declines
 * to re-decide an entry into the state it is already in. The key covers the
 * retry of one unanswered request; the route's own guard covers the press that
 * arrives after the client has let that key go.
 */

const TEST_TIMEOUT_MS = 20000;

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "admin-1", role: "admin" } }),
  useHasPermission: () => true,
}));

// jsdom has no canvas; the subcontractor QR card paints one on mount.
vi.mock("qrcode", () => ({ default: { toCanvas: async () => {} } }));

// Imported after the mocks above so the mocked modules are picked up.
import { SiteDetailPage } from "@/pages/SiteDetailPage";

/** The server's floor on key length — a shorter key is refused, not honoured. */
const MIN_KEY_LENGTH = 8;

/** How long the client keeps a settled intent's key before minting a new one. */
const KEY_HELD_AFTER_SUCCESS_MS = 2_000;

const SITE = {
  id: "site-1",
  name: "Downtown Tower",
  clientId: "client-1",
  address: "1 Main St",
  notes: null,
  // No coordinates: the geofence map iframe is not what these tests exercise.
  locationLat: null,
  locationLng: null,
  patrolIntervalMinutes: null,
  geofenceRadiusMiles: null,
};

const ENTRY = {
  id: "te-1",
  employeeName: "Erin Officer",
  clockInTime: "2026-08-18T13:00:00.000Z",
  clockOutTime: "2026-08-18T21:00:00.000Z",
  hoursWorked: "8.00",
  employeeEdited: false,
  confirmationStatus: "confirmed",
};

type Decision = "approved" | "rejected";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The parts of a decision response that say WHICH decision was answered. */
function answerOf(outcome: { status: number; body: unknown }) {
  const body = outcome.body as { approvalStatus: string; approvedAt: string };
  return { status: outcome.status, approvalStatus: body.approvalStatus, approvedAt: body.approvedAt };
}

/**
 * A stand-in API: the site page's reads, plus replay protection in front of the
 * approve/reject write.
 */
function makeApi() {
  /** Every decision POST that reached the wire, with the key it carried. */
  const attempts: Array<{ key: string | null; decision: Decision }> = [];
  /** What each of those attempts was answered with, in the same order. */
  const answers: Array<{ status: number; approvalStatus: string; approvedAt: string }> = [];
  /** One row per time the decision route actually ran — i.e. a real write. */
  const applied: Array<{ decision: Decision; hoursWorked: number | undefined; approvedAt: string }> = [];
  /** Recorded outcomes, keyed by actor-scope + route + resource + key. */
  const recorded = new Map<string, { status: number; body: unknown }>();

  const state = {
    /** What the entry's decision actually is on the server. */
    approvalStatus: "pending" as string,
    /** The hours the current decision was made on. */
    hoursWorked: Number(ENTRY.hoursWorked),
    /** When the current decision was stamped; a repeat must not move it. */
    approvedAt: null as string | null,
    /** Responses that were replayed from the record instead of performed. */
    replays: 0,
    /** Repeats the route itself refused to re-run (no key involved). */
    duplicatesRefused: 0,
    /**
     * List reads still to be answered from before the decision landed. A
     * lagging read is exactly what makes an admin press the button again: the
     * write went through but the refreshed row still says "Pending".
     */
    staleListReads: 0,
  };

  /** The entry as the server currently holds it. */
  const currentEntry = () => ({
    ...ENTRY,
    approvalStatus: state.approvalStatus,
    hoursWorked: state.hoursWorked.toFixed(2),
    approvedAt: state.approvedAt,
  });

  const fetchStub = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://test.local");
    const p = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();

    const decide = /^\/api\/time-entries\/([^/]+)\/approve$/.exec(p);
    if (decide && method === "POST") {
      const key = new Headers(init.headers).get("Idempotency-Key");
      const body = JSON.parse(String(init.body)) as { decision: Decision; hoursWorked?: number };
      attempts.push({ key, decision: body.decision });

      if (key !== null && key.length < MIN_KEY_LENGTH) {
        return jsonResponse(400, { message: "An idempotency key must be between 8 and 200 characters." });
      }

      // Scoped by route AND resource, so a key can only replay its own answer.
      const cacheKey = key ? `admin-1:POST:${p}:${key}` : null;
      const hit = cacheKey ? recorded.get(cacheKey) : undefined;
      if (hit) {
        state.replays += 1;
        answers.push(answerOf(hit));
        return jsonResponse(hit.status, hit.body, { "x-idempotent-replay": "true" });
      }

      // The handler runs — but the route refuses to re-decide a row into the
      // state it is already in, because that would re-stamp the approval and
      // roll the same hours into payroll and the client invoice again. It
      // answers with the entry as it stands rather than with an error.
      const unchanged =
        state.approvalStatus === body.decision &&
        (body.hoursWorked === undefined || body.hoursWorked === state.hoursWorked);
      if (unchanged) {
        state.duplicatesRefused += 1;
        const asItStands = { status: 200, body: currentEntry() };
        if (cacheKey) recorded.set(cacheKey, asItStands);
        answers.push(answerOf(asItStands));
        return jsonResponse(asItStands.status, asItStands.body);
      }

      const approvedAt = new Date(Date.now() + applied.length).toISOString();
      applied.push({ decision: body.decision, hoursWorked: body.hoursWorked, approvedAt });
      state.approvalStatus = body.decision;
      if (body.hoursWorked !== undefined) state.hoursWorked = body.hoursWorked;
      state.approvedAt = approvedAt;
      const outcome = {
        status: 200,
        body: currentEntry(),
      };
      if (cacheKey) recorded.set(cacheKey, outcome);
      answers.push(answerOf(outcome));
      return jsonResponse(outcome.status, outcome.body);
    }

    if (method === "GET") {
      if (p === "/api/time-entries") {
        const decided = state.approvalStatus !== "pending";
        const stale = decided && state.staleListReads > 0;
        if (stale) state.staleListReads -= 1;
        return jsonResponse(200, [stale ? { ...currentEntry(), approvalStatus: "pending" } : currentEntry()]);
      }
      if (p === `/api/admin/tables/sites/${SITE.id}`) return jsonResponse(200, SITE);
      if (p === `/api/admin/sites/${SITE.id}/checkpoints`) return jsonResponse(200, { checkpoints: [] });
      if (p === "/api/admin/patrol/scans") return jsonResponse(200, { scans: [] });
      if (p === "/api/admin/subcontractor-entries") return jsonResponse(200, []);
      if (p === "/api/dispatch/config") return jsonResponse(200, {});
      // Foreign-key option loads behind the page's edit dialog.
      if (/^\/api\/admin\/tables\/[^/]+$/.test(p)) return jsonResponse(200, { rows: [], total: 0 });
      if (p === `/api/sites/${SITE.id}/managers`) return jsonResponse(200, []);
      if (p === "/api/site-manager-candidates") return jsonResponse(200, []);
      if (p === `/api/admin/sites/${SITE.id}/rates`) return jsonResponse(200, []);
      if (p === `/api/admin/sites/${SITE.id}/subcontractor-qr`) return jsonResponse(200, { exists: false });
    }

    // Anything else the page reads is not what these tests are about; answer
    // the way a missing endpoint would so the page degrades instead of hanging.
    return jsonResponse(404, { message: "Not Found" });
  });

  return { attempts, answers, applied, state, fetchStub };
}

function renderPage() {
  const { hook, searchHook } = memoryLocation({ path: `/sites/${SITE.id}`, record: true });
  return render(
    <Router hook={hook} searchHook={searchHook}>
      <SiteDetailPage />
    </Router>,
  );
}

/** The pending row's Approve button (its label is a spinner while in flight). */
function approveButton(): Promise<HTMLButtonElement> {
  return screen.findByRole("button", { name: "Approve" }) as Promise<HTMLButtonElement>;
}

function expectNoActionError(): void {
  expect(screen.queryByTestId("time-entry-action-error")).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("approving a site's time entry", () => {
  it("sends an idempotency key the server will accept", async () => {
    const { attempts, applied, state, fetchStub } = makeApi();
    vi.stubGlobal("fetch", fetchStub);
    renderPage();

    fireEvent.click(await approveButton());

    await waitFor(() => expect(applied).toHaveLength(1));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.key).toBeTruthy();
    expect(attempts[0]!.key!.length).toBeGreaterThanOrEqual(MIN_KEY_LENGTH);
    // The hours shown on the row are what was approved.
    expect(applied[0]).toMatchObject({ decision: "approved", hoursWorked: 8 });
    expect(state.approvalStatus).toBe("approved");

    // The decided row is no longer actionable, and nothing failed.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expectNoActionError();
  }, TEST_TIMEOUT_MS);

  it("approves once when the same entry is approved twice", async () => {
    const { attempts, answers, applied, state, fetchStub } = makeApi();
    // The refresh after the approval still reads "Pending" — which is exactly
    // when an admin presses Approve a second time.
    state.staleListReads = 1;
    vi.stubGlobal("fetch", fetchStub);
    renderPage();

    fireEvent.click(await approveButton());
    await waitFor(() => expect(applied).toHaveLength(1));

    // The row came back still pending, so the admin presses Approve again.
    const again = await approveButton();
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);

    await waitFor(() => expect(attempts).toHaveLength(2));
    // Same intent, same key — so the write ran exactly once.
    expect(attempts[1]!.key).toBe(attempts[0]!.key);
    expect(applied).toHaveLength(1);
    expect(state.replays).toBe(1);

    // The second press is answered with the first one's outcome — the same
    // approval, stamped at the same moment — rather than an error, and the
    // entry ends up approved once.
    expect(answers[1]).toEqual(answers[0]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expectNoActionError();
    expect(state.approvalStatus).toBe("approved");
  }, TEST_TIMEOUT_MS);

  it("still approves only once when the repeat comes after the key was let go", async () => {
    const { attempts, applied, state, fetchStub } = makeApi();
    // Same stale refresh — but this time the admin looks away and comes back,
    // which is long enough for the client to stop holding the key.
    state.staleListReads = 1;
    vi.stubGlobal("fetch", fetchStub);
    const realNow = Date.now;
    const skew = { ms: 0 };
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew.ms);
    renderPage();

    fireEvent.click(await approveButton());
    await waitFor(() => expect(applied).toHaveLength(1));

    skew.ms = KEY_HELD_AFTER_SUCCESS_MS + 1_000;
    const again = await approveButton();
    await waitFor(() => expect(again.disabled).toBe(false));
    fireEvent.click(again);

    await waitFor(() => expect(attempts).toHaveLength(2));
    // The client has minted a fresh key by now, so replay protection cannot
    // save this one — the route has to refuse the repeat itself.
    expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
    expect(state.replays).toBe(0);
    expect(state.duplicatesRefused).toBe(1);
    expect(applied).toHaveLength(1);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expectNoActionError();
    expect(state.approvalStatus).toBe("approved");
  }, TEST_TIMEOUT_MS);

  it("treats a following rejection as its own decision, not a replay of the approval", async () => {
    const { attempts, answers, applied, state, fetchStub } = makeApi();
    // Same lagging refresh, so the decision buttons are still on the row.
    state.staleListReads = 1;
    vi.stubGlobal("fetch", fetchStub);
    renderPage();

    fireEvent.click(await approveButton());
    await waitFor(() => expect(applied).toHaveLength(1));

    // Having approved by mistake, the admin now rejects the same entry.
    const reject = (await screen.findByRole("button", { name: "Reject" })) as HTMLButtonElement;
    await waitFor(() => expect(reject.disabled).toBe(false));
    fireEvent.click(reject);

    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]!.decision).toBe("rejected");
    // A different intent gets a different key, so the rejection is not
    // answered from the approval's record — it actually runs.
    expect(attempts[1]!.key).toBeTruthy();
    expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
    expect(state.replays).toBe(0);
    expect(applied.map((a) => a.decision)).toEqual(["approved", "rejected"]);
    // The rejection is answered as a rejection, not with the approval's record.
    expect(answers[1]!.approvalStatus).toBe("rejected");

    await waitFor(() => expect(state.approvalStatus).toBe("rejected"));
    expectNoActionError();
  }, TEST_TIMEOUT_MS);
});
