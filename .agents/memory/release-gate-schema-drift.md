---
name: Release gate schema drift
description: Why a forgotten `db push` after a schema-adding commit breaks the test/security-headers release gates while typecheck stays green
---

A schema change committed in code but not applied to the dev DB silently
breaks releases.

**Symptom:** `test` gate fails with `column "<new_col>" ... does not exist`
(insert/select against the new column) and `security-headers` fails because
the spawned api-server can't boot — even though `typecheck` is GREEN.

**Why typecheck hides it:** the `typecheck` gate runs `pnpm run typecheck`,
which does `tsc --build` (typecheck:libs) FIRST, regenerating `@workspace/db`
declarations from the schema source. So the new columns typecheck fine. The
test/security-headers gates run against the live DB, which is still missing
the columns. The standalone `pnpm --filter @workspace/api-server run
typecheck` (no lib prebuild) can ALSO falsely fail on stale lib decls — not a
real break; the canonical gate rebuilds libs.

**How to apply:** when a build is "broken / blocks releases" after a
schema-touching commit, don't trust the task's described symptom — run all
gates (`pnpm run typecheck`, `pnpm -r --if-present run test`,
security-headers) and check for `column ... does not exist`. Fix is
`pnpm --filter @workspace/db run push`, not a code edit.
