/**
 * Re-export of the shared @workspace/assistant-chat-client functions used by
 * AiBotChatScreen's chat + pending-action approval flow, and by its
 * "what you're not using" suggestions panel (fetchSuggestions,
 * dismissSuggestion).
 *
 * AiBotChatScreen.tsx is a React Native component and the mobile test runner
 * is Node with no RN renderer (see .agents/memory/vitest-rn-import-parse-error.md),
 * so this module (and its sibling ../aiBotChat test) exercises the request/
 * response logic through this RN-free re-export rather than the screen
 * itself — the exact same functions the screen wires its `send()` /
 * `resolvePending()` / `dismissFinding()` handlers to.
 *
 * The actual request/response shaping lives in @workspace/assistant-chat-client
 * so the admin portal (artifacts/admin-portal/src/pages/Assistant.tsx) shares
 * it instead of keeping an independent copy — see that package's doc comment
 * for why.
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
