---
name: adminGridTimeEntryInvoiceSync parallel flake (FIXED)
description: Was a DB race under concurrent file execution; fixed by fileParallelism:false in vitest config.
---

`artifacts/api-server/src/__tests__/adminGridTimeEntryInvoiceSync.test.ts` used to fail with `duplicate key value violates unique constraint` (23505) when running under the full `pnpm -r test` gate.

**Root cause:** vitest's `fileParallelism` defaults to `true` even when `singleFork: true` is set, so test files ran concurrently within the single fork. The test's manual draft-invoice insert raced the auto invoice-sync upsert against the same `(siteId, ISO-week)` bucket.

**Fix:** added `fileParallelism: false` to `artifacts/api-server/vitest.config.ts`. All test files now run strictly sequentially inside the single fork, eliminating the concurrent-DB-write race. Also raised `testTimeout`/`hookTimeout` from 30 s to 60 s to give heavier suites (chatMembershipLifecycle, dispatch) enough headroom.

**How to apply:** if a new suite mutates global/shared DB state (single-row config tables, global counters), `fileParallelism: false` already protects it. Do NOT revert to concurrent execution to speed up CI — the DB on this project is a single shared instance and concurrent writes cause 23505 flakes.
