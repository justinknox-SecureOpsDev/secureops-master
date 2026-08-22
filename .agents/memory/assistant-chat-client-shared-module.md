---
name: Cross-platform assistant chat client
description: Where the Secure Ops AI Bot's chat/approve/discard/status AND suggestions fetch/dismiss request-response logic lives, shared between admin-portal (web) and security-ops (mobile).
---

The AI Bot chat, pending-action approve/discard, status-check, and adoption-
suggestions (fetch + dismiss) logic for `/assistant/chat`,
`/assistant/actions/:id/approve|discard`, `/assistant/status`, and
`/assistant/suggestions[/:id/dismiss]` used to be implemented independently in
`artifacts/admin-portal/src/pages/Assistant.tsx` (web, React) and
`artifacts/security-ops/components/chat/aiBotChat.ts` +
`AiBotChatScreen.tsx` (mobile, React Native). Nothing kept them in sync, so a
change to one side's request/response shaping could silently diverge from the
other.

That logic now lives in one place: `lib/assistant-chat-client` (workspace
package `@workspace/assistant-chat-client`), a framework-light module (no
React/React Native/HTTP-client dependency — callers pass their own
`apiRequest` function). Both surfaces call the shared functions directly
instead of keeping their own copies. Each surface still keeps its own
category→label/tone presentation mapping and its own choice of whether a
failed suggestions fetch/dismiss surfaces a toast — that's UI feedback, not
request/response shaping, so it's fine for it to differ.

**Why:** this is the standard convention in this repo for cross-surface
constants/logic (see `lib/feature-keys`, `lib/permission-keys`,
`lib/screen-names` — small `lib/*` workspace packages with a `src/index.ts`
and no build step, consumed via `workspace:*`).

**How to apply:** any new `/assistant/*` request/response shaping shared by
both surfaces belongs in `@workspace/assistant-chat-client`, not duplicated.
`fetchSuggestions` normalizes a missing/malformed `findings` field to `[]` but
still throws on a request failure (caller decides how loudly to surface it);
`dismissSuggestion` never throws — it resolves `true`/`false` so callers can
do the optimistic-remove-then-rollback-on-failure pattern without duplicating
the request shape.
