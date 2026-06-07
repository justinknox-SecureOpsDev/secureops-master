---
name: Clock-in nearest-site test shared-DB pollution
description: Why timeEntriesClockIn nearest-site/auto-assign tests flake in the full suite but pass alone
---

`api-server` `timeEntriesClockIn.test.ts` nearest-site + auto-assign tests pin a fixture site at fixed remote coords (South Atlantic, ~`-54.12, -12.65`) chosen so the geo-resolver can ONLY match that fixture. `afterAll` cleans up by `name LIKE '<random per-run TAG>%'`.

**Symptom:** In the full parallel suite they fail with `expected <nearSiteId> to be <other-site-id>` (nearest resolved to a different site) and auto-assign `shiftId` comes back `null`; the same file passes 13/13 in isolation. Both failures share one root: a competing site exists within 1 mile of those coords during the run.

**Why:** The shared dev DB (this project runs against prod-adjacent data) accumulates an orphan site at those coords from any run that dies before `afterAll`. Because the cleanup key is a per-run random TAG, an orphan from a different run is never reclaimed by a later run.

**How to apply:** Treat these two failures as DATA pollution, not a code regression — especially when your diff doesn't touch clock-in/geo/auto-assign. Verify with `SELECT ... FROM sites WHERE location_lat::float8 BETWEEN -55 AND -53`; delete any orphan site at those coords, then re-run. Avoid killing the api-server vitest run mid-flight (its import phase is ~50-80s) since that is how orphans get created.
