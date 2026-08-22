---
name: Admin/mobile AI Bot chat modules are hand-duplicated
description: Both the admin-portal and mobile Secure Ops AI Bot chat screens now have their own framework-light request module; there is no shared package between them.
---

The admin portal's `artifacts/admin-portal/src/lib/aiBotChat.ts` and the
mobile app's `artifacts/security-ops/components/chat/aiBotChat.ts` are two
independent files with intentionally identical exports
(`fetchAssistantReply`, `resolvePendingActionOutcome`,
`checkAssistantConfigured`, and the `PendingAction`/`ChatReply`/`Turn`
types) hand-copied to mirror each other, not a shared workspace package.

**Why:** each side needed the same chat/pending-action request logic pulled
out of its screen component so it could be unit-tested without a renderer
(the mobile one because Vitest can't parse React Native's `import typeof`;
the admin one because it previously had only a knowledge-base coverage test,
nothing exercising the actual chat/approve/discard behavior). No shared
package existed at the time, so both copies were written against each
platform's own `api()`/`apiRequest` helper.

**How to apply:** any change to the request/response shape of
`/assistant/chat`, `/assistant/actions/:id/approve|discard`, or
`/assistant/status` must be applied to BOTH files (and both test files)
in lockstep, or the two clients silently diverge. If a shared package is
ever introduced to de-duplicate them, update this note.
