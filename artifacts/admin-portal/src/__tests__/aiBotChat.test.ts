/**
 * Coverage for the admin-portal Secure Ops AI Bot chat/pending-action flow.
 *
 * src/pages/Assistant.tsx wires its send()/resolvePending() handlers straight
 * to the functions in ../lib/aiBotChat, so we exercise those directly rather
 * than rendering the page — the existing assistantKbCoverage.test.ts only
 * checks that the knowledge base points at real pages, nothing exercised the
 * actual chat/approve/discard request behavior. This is what would have
 * caught a regression in message sending, dropped history, or a broken
 * approve/discard round trip shipping silently. Mirrors the mobile
 * equivalent: artifacts/security-ops/components/chat/__tests__/aiBotChat.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  checkAssistantConfigured,
  dismissSuggestion,
  fetchAssistantReply,
  fetchSuggestions,
  resolvePendingActionOutcome,
  type PendingAction,
} from "../lib/aiBotChat";

const ACTION: PendingAction = {
  id: "act-123",
  summary: "Approve shift swap for J. Smith",
  details: [{ label: "Site", value: "HQ" }],
  expiresAt: "2026-08-22T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// fetchAssistantReply — POST /assistant/chat
// ---------------------------------------------------------------------------

describe("fetchAssistantReply", () => {
  it("calls POST /assistant/chat with the message and prior turns as history", async () => {
    const apiRequest = vi.fn().mockResolvedValue({
      reply: "You have 2 open invoices this week.",
      pendingAction: null,
      actionsTaken: [],
    });

    const priorTurns = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello! How can I help?" },
    ];

    const turn = await fetchAssistantReply(apiRequest, priorTurns, "How do I run payroll?");

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [path, options] = apiRequest.mock.calls[0];
    expect(path).toBe("/assistant/chat");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      message: "How do I run payroll?",
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello! How can I help?" },
      ],
    });

    expect(turn).toEqual({
      role: "assistant",
      content: "You have 2 open invoices this week.",
      pendingAction: null,
      actionsTaken: [],
    });
  });

  it("returns the pendingAction and actionsTaken from the reply untouched", async () => {
    const apiRequest = vi.fn().mockResolvedValue({
      reply: "I can request that shift swap for you — approve to proceed.",
      pendingAction: ACTION,
      actionsTaken: [{ tool: "lookupShift", ok: true, message: "Found the shift" }],
    });

    const turn = await fetchAssistantReply(apiRequest, [], "Swap J. Smith's Friday shift");

    expect(turn.pendingAction).toEqual(ACTION);
    expect(turn.actionsTaken).toEqual([{ tool: "lookupShift", ok: true, message: "Found the shift" }]);
  });

  it("turns a request failure into an assistant turn with the error message, never throwing", async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error("Request failed (500)"));

    const turn = await fetchAssistantReply(apiRequest, [], "Hello?");

    expect(turn).toEqual({
      role: "assistant",
      content: "I couldn't answer that: Request failed (500)",
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePendingActionOutcome — approve / discard
// ---------------------------------------------------------------------------

describe("resolvePendingActionOutcome — approve", () => {
  it("calls POST /assistant/actions/:id/approve and returns an ok resolution", async () => {
    const apiRequest = vi.fn().mockResolvedValue({ summary: "Shift swap approved." });

    const outcome = await resolvePendingActionOutcome(apiRequest, ACTION, true);

    expect(apiRequest).toHaveBeenCalledWith("/assistant/actions/act-123/approve", { method: "POST" });
    expect(outcome).toEqual({ ok: true, text: "Shift swap approved." });
  });

  it("appends the note to the summary when the approve response includes one", async () => {
    const apiRequest = vi.fn().mockResolvedValue({
      summary: "Shift swap approved.",
      note: "J. Smith was notified.",
    });

    const outcome = await resolvePendingActionOutcome(apiRequest, ACTION, true);

    expect(outcome).toEqual({ ok: true, text: "Shift swap approved. J. Smith was notified." });
  });

  it("URL-encodes the action id", async () => {
    const apiRequest = vi.fn().mockResolvedValue({ summary: "Done" });
    await resolvePendingActionOutcome(apiRequest, { ...ACTION, id: "act/with space" }, true);
    expect(apiRequest).toHaveBeenCalledWith("/assistant/actions/act%2Fwith%20space/approve", { method: "POST" });
  });

  it("returns an ok:false resolution with the error message when approve fails", async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error("This action has expired."));

    const outcome = await resolvePendingActionOutcome(apiRequest, ACTION, true);

    expect(outcome).toEqual({ ok: false, text: "This action has expired." });
  });
});

describe("resolvePendingActionOutcome — discard", () => {
  it("calls POST /assistant/actions/:id/discard and returns a cancelled resolution", async () => {
    const apiRequest = vi.fn().mockResolvedValue(null);

    const outcome = await resolvePendingActionOutcome(apiRequest, ACTION, false);

    expect(apiRequest).toHaveBeenCalledWith("/assistant/actions/act-123/discard", { method: "POST" });
    expect(outcome).toEqual({ ok: false, text: "Cancelled — nothing was changed." });
  });

  it("never calls approve when discarding", async () => {
    const apiRequest = vi.fn().mockResolvedValue(null);
    await resolvePendingActionOutcome(apiRequest, ACTION, false);
    expect(apiRequest).not.toHaveBeenCalledWith(expect.stringContaining("/approve"), expect.anything());
  });

  it("returns an ok:false resolution with the error message when discard fails", async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error("Network request failed"));

    const outcome = await resolvePendingActionOutcome(apiRequest, ACTION, false);

    expect(outcome).toEqual({ ok: false, text: "Network request failed" });
  });
});

// ---------------------------------------------------------------------------
// checkAssistantConfigured — GET /assistant/status
// ---------------------------------------------------------------------------

describe("checkAssistantConfigured", () => {
  it("resolves true when the status endpoint reports configured", async () => {
    const apiRequest = vi.fn().mockResolvedValue({ configured: true });
    await expect(checkAssistantConfigured(apiRequest)).resolves.toBe(true);
    expect(apiRequest).toHaveBeenCalledWith("/assistant/status");
  });

  it("resolves false when the status endpoint reports not configured", async () => {
    const apiRequest = vi.fn().mockResolvedValue({ configured: false });
    await expect(checkAssistantConfigured(apiRequest)).resolves.toBe(false);
  });

  it("resolves false (never rejects) when the status request throws", async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error("Can't reach the server"));
    await expect(checkAssistantConfigured(apiRequest)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchSuggestions / dismissSuggestion — the "what you're not using" panel
// ---------------------------------------------------------------------------

describe("fetchSuggestions", () => {
  it("calls GET /assistant/suggestions and returns the findings array", async () => {
    const findings = [
      {
        id: "f1",
        category: "money" as const,
        title: "Unbilled hours",
        evidence: "12 hours worked, none invoiced.",
        benefit: "Bill for the hours you already covered.",
        route: "/invoices",
        routeLabel: "Invoices",
      },
    ];
    const apiRequest = vi.fn().mockResolvedValue({ findings });

    await expect(fetchSuggestions(apiRequest)).resolves.toEqual(findings);
    expect(apiRequest).toHaveBeenCalledWith("/assistant/suggestions");
  });

  it("normalizes a missing or malformed findings field to an empty array", async () => {
    const apiRequest = vi.fn().mockResolvedValue({});
    await expect(fetchSuggestions(apiRequest)).resolves.toEqual([]);
  });

  it("throws when the request fails, so callers can decide how to surface it", async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error("Request failed (500)"));
    await expect(fetchSuggestions(apiRequest)).rejects.toThrow("Request failed (500)");
  });
});

describe("dismissSuggestion", () => {
  it("calls POST /assistant/suggestions/:id/dismiss and resolves true on success", async () => {
    const apiRequest = vi.fn().mockResolvedValue(undefined);
    await expect(dismissSuggestion(apiRequest, "f1")).resolves.toBe(true);
    expect(apiRequest).toHaveBeenCalledWith("/assistant/suggestions/f1/dismiss", { method: "POST" });
  });

  it("URL-encodes the finding id", async () => {
    const apiRequest = vi.fn().mockResolvedValue(undefined);
    await dismissSuggestion(apiRequest, "f/with space");
    expect(apiRequest).toHaveBeenCalledWith("/assistant/suggestions/f%2Fwith%20space/dismiss", { method: "POST" });
  });

  it("resolves false (never throws) when the request fails", async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error("Request failed (500)"));
    await expect(dismissSuggestion(apiRequest, "f1")).resolves.toBe(false);
  });
});
