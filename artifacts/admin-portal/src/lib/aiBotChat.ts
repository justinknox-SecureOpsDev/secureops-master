/**
 * Re-export of the shared @workspace/assistant-chat-client functions used by
 * AssistantPage's chat + pending-action approval flow (../pages/Assistant.tsx),
 * and by its "what you're not using" suggestions panel (fetchSuggestions,
 * dismissSuggestion).
 *
 * The actual request/response shaping (POST /assistant/chat, POST
 * /assistant/actions/:id/approve|discard, GET /assistant/status, GET
 * /assistant/suggestions, POST /assistant/suggestions/:id/dismiss) lives in
 * @workspace/assistant-chat-client so the mobile app's equivalent screen
 * (artifacts/security-ops/components/chat/aiBotChat.ts) shares it instead of
 * keeping an independent copy — see that package's doc comment for why.
 * ../__tests__/aiBotChat.test.ts exercises the request/response logic through
 * this re-export, the exact same functions AssistantPage wires its send()/
 * resolvePending()/dismiss() handlers to.
 */

export {
  checkAssistantConfigured,
  dismissSuggestion,
  fetchAssistantReply,
  fetchSuggestions,
  resolvePendingActionOutcome,
  type ApiRequestFn,
  type ChatReply,
  type PendingAction,
  type Suggestion,
  type SuggestionCategory,
  type Turn,
} from "@workspace/assistant-chat-client";
