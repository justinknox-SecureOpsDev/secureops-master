---
name: api-server tests must not run files in parallel
description: vitest fileParallelism must stay false for api-server — shared single DB makes concurrent file execution race (23505 flakes).
---

api-server test files share ONE real Postgres instance. vitest's
`fileParallelism` defaults to `true` even with `singleFork: true`, which
let files run concurrently and race DB writes (e.g. a manual draft-invoice
insert vs the auto invoice-sync upsert on the same `(siteId, ISO-week)`
bucket → `23505 duplicate key`).

**Why:** there is no per-file DB isolation; any suite mutating shared
state (invoice buckets, singleton config rows, global counters) can
collide with another file's writes.

**How to apply:** `fileParallelism: false` is set in
`artifacts/api-server/vitest.config.ts` — do NOT revert it to speed up CI.
If a 23505-style flake appears under the full gate but passes alone,
suspect concurrent-write pollution, not the code under test.
