---
name: Stale red gate after split test/impl task merges
description: Why the test (or any) gate can show red even though the current code is correct — and how to tell before "fixing" anything.
---

# Stale red gate after split test/impl task merges

Independent task agents merge as **separate** tasks in this project, and the
release gates (`test`, `typecheck`, etc.) run per-merge. When a *tests-only*
task merges **before** its companion *implementation* task, the gate runs in the
gap and legitimately goes red — the new tests exercise a feature the code
doesn't have yet. Once the implementation task merges, the code is correct, but
the gate keeps showing its **stale** red until it is re-run.

Concrete tell: compare the test COUNT in the failed gate log vs the current
file. If the file grew (e.g. 31 tests → 36) and now passes, a later merge landed
after the failing run — the red predates the current code.

## How to apply
When a gate is red but the diff/code looks correct:
1. Re-run the actual suite locally first —
   `pnpm --filter @workspace/<pkg> run test` (api-server needs the whole file
   set; it's serial via `fileParallelism:false`). If it's green, there is
   nothing to fix in code.
2. Read the *failed gate's* log (`/tmp/logs/test_*.log`) to confirm the failure
   was the now-fixed area and not a still-latent one in another package (the
   `test` gate runs `pnpm -r --if-present run test` across ALL packages).
3. Clear the status by restarting the gate workflow — do NOT edit already-correct
   code to chase a stale failure.

**Why:** sequential task-agent merges + per-merge gates make a tests-first merge
order produce a real-but-transient red. This is distinct from the flake/race and
schema-drift gate-red causes already in memory.
