---
name: Scheduler sync test hardcoded-date time bomb
description: schedulerSyncIntegration.test.ts uses hardcoded calendar dates as stand-ins for "past"/"future"; they expire as real time catches up.
---

`processInboundClockEvent`'s dedup/merge test ("merges into the existing
local entry rather than creating a duplicate") asserted a payload
`updatedAt` of a fixed date-string that was future-dated when the test was
written. The local row being merged into gets its `updatedAt` from the DB's
real wall-clock `now()`. Once real time passed the hardcoded date, the
LWW tiebreak (see `scheduler-sync-lww-tiebreaker.md`) flipped the expected
`action` from `"updated"` to `"skipped"`, failing the test — with zero
code change involved.

**Why:** the file already has a `FAR_FUTURE`/`FAR_PAST` constant pattern
(`"2999-01-01..."` / `"2000-01-01..."`) for tests that need an
unambiguous "clearly newer"/"clearly older" payload, but a few older
tests in the same file predate that convention and hardcode nearby
same-year dates instead.

**How to apply:** if a scheduler-sync test starts failing with
`expected 'skipped' to be 'updated'` (or vice versa) with no related code
change, check whether the test's hardcoded `updatedAt` has been overtaken
by real time — fix by switching it to the file's `FAR_FUTURE`/`FAR_PAST`
constants (or an equivalently far date) rather than debugging the merge
logic itself. Worth sweeping the rest of the file's hardcoded 2026 dates
proactively since more will expire day by day.
