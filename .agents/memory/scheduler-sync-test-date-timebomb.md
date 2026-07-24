---
name: Scheduler sync test hardcoded-date time bomb
description: Hardcoded "nearby" calendar dates in LWW-tiebreak tests expire as real time passes and silently flip expected outcomes.
---

Tests that pit a payload `updatedAt` against a DB wall-clock `now()` (the
scheduler-sync LWW tiebreak — see `scheduler-sync-lww-tiebreaker.md`) must
never use hardcoded nearby calendar dates as "future"/"past" stand-ins.
Once real time overtakes the date, the tiebreak flips and the test fails
(`expected 'skipped' to be 'updated'` or vice versa) with zero code change.

**Why:** the local row's `updatedAt` comes from the DB's real `now()`; a
fixed date-string is only "newer" until the calendar catches up.

**How to apply:**
- Use `Date.now()`-relative helpers (a `rel(days, hours)` block already
  exists in `schedulerSyncIntegration.test.ts`) or unambiguous extremes
  (`FAR_PAST`/`FAR_FUTURE` sentinel constants).
- Safe to hardcode: dates only compared against each other, bucket keys,
  opaque cursors, deliberately-invalid inputs.
- Sequential upserts that must each win the LWW need strictly increasing
  offsets (`rel(-5)` → `rel(-3)` → `rel(-1)`); decreasing offsets make the
  later call lose and return `"skipped"`.
