---
name: Admin nav snapshot test
description: Adding/renaming/removing an admin-portal sidebar nav item breaks two tests — the exact-list snapshot and the assistant knowledge-base coverage check
---

Two separate tests are pinned to the admin nav. Both are intentional; neither is the nav's fault.

## 1. Exact-list snapshot
Adding or removing an item in `buildNavGroups` (artifacts/admin-portal/src/pages/AppShell.tsx) breaks `src/pages/__tests__/navGroups.test.ts`, which asserts the **exact ordered href list** per group (e.g. the "hr" group). The `test` gate fails with a deep-equal diff even though the change is correct.

**Why:** the test is a regression snapshot of nav structure, not a behavior test.

**How to apply:** whenever you touch a nav group's items, update the matching `expect(...).toEqual([...])` array in navGroups.test.ts in lockstep. Fix = update the test, not the nav.

## 2. Assistant knowledge-base coverage
`src/__tests__/assistantKbCoverage.test.ts` ties the nav + wouter route table to the AI assistant's hand-written how-to content in api-server (`lib/assistant/knowledgeBase.ts`). It fails when a page has no article and no reasoned entry in `KB_ROUTES_WITHOUT_ARTICLE`, when the KB points at a route that no longer exists, and when an article's prose breadcrumb ("Accounting > Pay Run") names a tab or page the nav no longer has. Suggestion-card `routeLabel`s in `lib/assistant/signals.ts` are checked the same way.

**Why:** the assistant confidently narrates portal navigation from prose that nothing else validates, and a wrong walkthrough is worse than no answer because the reader follows it.

**How to apply:** a nav rename/move/removal means editing knowledgeBase.ts too — the failure message names the page and lists the tab's current items. Ship a new page = claim it in an article's `route`/`alsoCovers` or say in `KB_ROUTES_WITHOUT_ARTICLE` why it needs no how-to. The test lives in admin-portal because knowledgeBase.ts is dependency-free and imports cleanly across the artifact boundary; `.test.ts` files are excluded from admin-portal's tsconfig, so cross-artifact imports there cost nothing at typecheck.
