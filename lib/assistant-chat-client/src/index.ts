/**
 * Framework-light request/response shaping for the Secure Ops AI Bot: the
 * chat + pending-action approval flow, and the adjacent "what you're not
 * using" suggestions panel.
 *
 * The admin portal (React, artifacts/admin-portal/src/pages/Assistant.tsx)
 * and the mobile app (React Native, via
 * artifacts/security-ops/components/chat/aiBotChat.ts and
 * AiBotChatScreen.tsx) both talk to the exact same routes — GET
 * /assistant/status, POST /assistant/chat, POST
 * /assistant/actions/:id/approve|discard, GET /assistant/suggestions, POST
 * /assistant/suggestions/:id/dismiss — with the same request/response
 * shapes. Before this package existed each surface had its own independent
 * copy of that logic, so a change to one (a new field on the approve
 * response, a different not-configured behavior, a different
 * optimistic-removal-on-failure behavior for a dismissed suggestion) could
 * silently diverge from the other. Both surfaces now import these functions
 * directly instead of re-implementing them, so there is exactly one place
 * that decides WHAT gets sent to /assistant/* and HOW a response or failure
 * turns into UI state.
 *
 * This module has no dependency on React, React Native, or any HTTP client —
 * callers supply their own `apiRequest` (the admin portal's `api()`, the
 * mobile app's `apiRequest()`), which keeps this testable with plain Vitest
 * and safe to import from either a DOM or a Node/RN test environment (see
 * .agents/memory/vitest-rn-import-parse-error.md).
 */

export type PendingAction = {
  id: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  expiresAt: string;
};

export type ChatReply = {
  reply: string;
  pendingAction: PendingAction | null;
  actionsTaken: Array<{ tool: string; ok: boolean; message: string }>;
  notConfigured?: true;
};

export type Turn = {
  role: "user" | "assistant";
  content: string;
  pendingAction?: PendingAction | null;
  actionsTaken?: Array<{ tool: string; ok: boolean; message: string }>;
  /** Set once the card has been resolved so it stops offering buttons. */
  resolution?: { ok: boolean; text: string };
};

export type ApiRequestFn = (path: string, options?: RequestInit) => Promise<any>;

/**
 * Calls POST /assistant/chat with the running conversation as history and
 * returns the new assistant turn. Never throws — a request failure (network,
 * 4xx/5xx) becomes an assistant turn surfacing the error message instead, so
 * the caller can always append the result to `turns` unconditionally.
 */
export async function fetchAssistantReply(
  apiRequest: ApiRequestFn,
  priorTurns: Array<Pick<Turn, "role" | "content">>,
  message: string,
): Promise<Turn> {
  try {
    const res: ChatReply = await apiRequest("/assistant/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        history: priorTurns.map((t) => ({ role: t.role, content: t.content })),
      }),
    });
    return {
      role: "assistant",
      content: res.reply,
      pendingAction: res.pendingAction,
      actionsTaken: res.actionsTaken,
    };
  } catch (err) {
    return { role: "assistant", content: `I couldn't answer that: ${(err as Error).message}` };
  }
}

/**
 * Resolves a pending action by approving (POST .../approve) or discarding
 * (POST .../discard) it, returning the `resolution` to attach to the turn
 * that carried the pending action. Never throws — a request failure becomes
 * an `ok: false` resolution carrying the error message.
 */
export async function resolvePendingActionOutcome(
  apiRequest: ApiRequestFn,
  action: PendingAction,
  approve: boolean,
): Promise<{ ok: boolean; text: string }> {
  try {
    if (approve) {
      const res = await apiRequest(`/assistant/actions/${encodeURIComponent(action.id)}/approve`, {
        method: "POST",
      });
      // `note` only comes back when the first attempt was interrupted and the
      // server reconciled it. Show it — the reassurance that it landed once,
      // and only once, is the whole point.
      return { ok: true, text: res.note ? `${res.summary} ${res.note}` : res.summary };
    }
    await apiRequest(`/assistant/actions/${encodeURIComponent(action.id)}/discard`, { method: "POST" });
    return { ok: false, text: "Cancelled — nothing was changed." };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
}

/**
 * GET /assistant/status → whether the bot is configured. Resolves to `false`
 * (never rejects) on any failure so a not-configured banner and disabled
 * input can show instead of the UI getting stuck on "checking".
 */
export async function checkAssistantConfigured(apiRequest: ApiRequestFn): Promise<boolean> {
  try {
    const s = await apiRequest("/assistant/status");
    return !!s?.configured;
  } catch {
    return false;
  }
}

export type SuggestionCategory = "money" | "compliance" | "client" | "dispatch" | "admin";

/** One "what you're not using" adoption finding from GET /assistant/suggestions. */
export type Suggestion = {
  id: string;
  category: SuggestionCategory;
  title: string;
  evidence: string;
  benefit: string;
  route: string;
  routeLabel: string;
};

/**
 * Calls GET /assistant/suggestions and returns the findings array. Throws on
 * a request failure (network, 4xx/5xx) — callers decide how loudly to
 * surface that (the admin portal toasts it, the mobile app treats the panel
 * as supplementary and stays silent), but both must agree on how a
 * successful response is shaped: a missing or malformed `findings` field
 * normalizes to `[]` rather than crashing a page that also renders a chat.
 */
export async function fetchSuggestions(apiRequest: ApiRequestFn): Promise<Suggestion[]> {
  const data = await apiRequest("/assistant/suggestions");
  return Array.isArray(data?.findings) ? data.findings : [];
}

/**
 * Calls POST /assistant/suggestions/:id/dismiss. Returns `true` on success
 * and `false` on any failure (never throws), so both surfaces can implement
 * the same "remove it from the list immediately, then put it back if the
 * server didn't confirm" optimistic-update pattern without duplicating the
 * request shape or the id-encoding detail:
 *
 * ```ts
 * setSuggestions((prev) => prev.filter((f) => f.id !== id));
 * if (!(await dismissSuggestion(apiRequest, id))) {
 *   // server didn't confirm — reload the real list rather than leaving a
 *   // suggestion invisible that the server still has active.
 *   void reload();
 * }
 * ```
 */
export async function dismissSuggestion(apiRequest: ApiRequestFn, id: string): Promise<boolean> {
  try {
    await apiRequest(`/assistant/suggestions/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    return true;
  } catch {
    return false;
  }
}
