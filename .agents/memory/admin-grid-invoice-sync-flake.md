---
name: api-server tests must not run files in parallel
description: The api-server suite shares one real database, so file-level parallelism must stay off; unexplained unique-violation flakes are write pollution, not regressions.
---

api-server test files share ONE real Postgres instance, and the test runner
would otherwise run files concurrently. File parallelism is therefore disabled
for that package — do not re-enable it to speed things up.

**Why:** there is no per-file database isolation. Any suite mutating shared
state (invoice buckets, singleton config rows, global counters) can collide
with another file's writes and surface as a duplicate-key failure in code that
is perfectly correct.

**How to apply:** serializing files only isolates the suite from ITSELF. The
same dev database is also shared with other runs happening at the same time
(parallel task validations and merges), which no runner setting can serialize.
Read the failure's shape: the same file failing every time = real; a different
unrelated file each attempt, each passing in isolation, or a count assertion
inflated by rows nobody in this suite created = foreign-run pollution — re-run
rather than editing the named test.
