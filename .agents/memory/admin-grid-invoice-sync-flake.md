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

Serializing files only isolates a suite from ITSELF. The same dev DB is also
shared with other runs happening at the same time (parallel task validations
and merges), which no test-runner setting can serialize. Read the failure's
shape: the same file every time = real; a different unrelated file each
attempt, each passing in isolation, or a count assertion inflated by rows
nobody in this suite created = foreign-run pollution — re-run rather than
editing the named test.
