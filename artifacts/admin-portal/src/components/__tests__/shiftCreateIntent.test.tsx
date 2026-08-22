import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ShiftDialog } from "@/components/ShiftDialog";

/**
 * Closing the shift dialog does not stop a create the server already has.
 *
 * Cancel / Escape / the X only take the dialog off the screen. If re-opening
 * minted a fresh intent, the next Save would carry a new idempotency key and
 * the server would treat it as a separate creation — the same shifts, twice.
 * So the intent has to survive a close-and-reopen for exactly as long as the
 * first attempt's outcome is unknown.
 *
 * This drives the real dialog through the real `api()` helper and stubs only
 * `fetch`, so what is asserted is what actually goes on the wire.
 */

vi.mock("@/lib/fk", () => ({
  useFkOptions: () => ({ options: [], loading: false, refresh: () => {} }),
}));

/** The body replay protection sends while an identical keyed request runs. */
const IN_FLIGHT_BODY = {
  error: "Conflict",
  code: "idempotency_in_flight",
  message: "An identical request with this key is still being processed.",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fillCreateForm() {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Night patrol" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2026-09-01T22:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "2026-09-02T06:00" } });
}

describe("creating a shift whose outcome the server never confirmed", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses the same key when the dialog is closed and re-opened mid-save", async () => {
    /** Every bulk-create that reached the wire, with the key it carried. */
    const keys: Array<string | null> = [];
    let serverConfirms = false;

    const fetchStub = vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/shifts/bulk-create") {
        keys.push(new Headers(init.headers).get("Idempotency-Key"));
        return serverConfirms
          ? jsonResponse(201, { created: 1 })
          : jsonResponse(409, IN_FLIGHT_BODY);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchStub);

    const onSaved = vi.fn();
    const view = (open: boolean) => (
      <ShiftDialog open={open} onOpenChange={() => {}} onSaved={onSaved} initial={null} />
    );
    const { rerender } = render(view(true));

    // ── First attempt: the server never finishes it. ──
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create shift" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    vi.useRealTimers();

    expect(screen.getByRole("status").textContent).toMatch(/still saving/i);
    expect(onSaved).not.toHaveBeenCalled();
    const attemptsBeforeClose = keys.length;
    expect(attemptsBeforeClose).toBeGreaterThan(0);

    // ── The person closes the dialog and opens it again. ──
    rerender(view(false));
    rerender(view(true));

    // ── Second attempt, this time the server answers. ──
    serverConfirms = true;
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create shift" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    // The whole point: the re-opened dialog carried the ORIGINAL key, so the
    // server could recognise this as the same creation rather than a new one.
    expect(keys.length).toBeGreaterThan(attemptsBeforeClose);
    expect(new Set(keys).size).toBe(1);
  }, 20_000);

  it("starts a fresh intent once a save has been confirmed", async () => {
    // Creating the same shift twice on purpose must still work — a settled
    // intent is over, and the next opening is a new one.
    const keys: Array<string | null> = [];
    const fetchStub = vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/shifts/bulk-create") {
        keys.push(new Headers(init.headers).get("Idempotency-Key"));
        return jsonResponse(201, { created: 1 });
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchStub);

    const onSaved = vi.fn();
    const view = (open: boolean) => (
      <ShiftDialog open={open} onOpenChange={() => {}} onSaved={onSaved} initial={null} />
    );
    const { rerender } = render(view(true));

    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create shift" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    rerender(view(false));
    rerender(view(true));

    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "Create shift" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
