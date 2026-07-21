---
name: Rollbacks can drop UI while server half survives
description: When the user says "X worked before, now it can't be done", check git history for a "Restored to ..." rollback that removed the UI — the API endpoints and tests often survive.
---

**Rule:** When the user reports a previously-working feature is gone, before rebuilding anything run `git log -S "<endpoint or keyword>" --oneline` on the relevant surface. In this repo, user-initiated checkpoint rollbacks create "Restored to '<sha>'" commits that can silently remove a client-side feature while the api-server routes, zod schemas, and tests for it remain fully intact (payroll board archive was lost this way).

**Why:** The server and client halves of a feature land in one commit, but rollbacks restore whole-tree snapshots chosen by checkpoint, and later work can be layered on the rolled-back state — so the tree ends up with live, tested endpoints that no UI calls. Rebuilding from scratch wastes effort and risks contract drift; the exact lost UI is recoverable via `git show <pre-rollback-sha>:<file>`.

**How to apply:** Find the commit that added the feature, confirm which "Restored to" commit dropped it (grep the old file at each candidate sha), then port the lost pieces into the CURRENT file — do not wholesale revert, because post-rollback commits (and other deliberately-rolled-back changes, e.g. timezone rendering) must be preserved. Verify against the still-existing server endpoints end-to-end.
