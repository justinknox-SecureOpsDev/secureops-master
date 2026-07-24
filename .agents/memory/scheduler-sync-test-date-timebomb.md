---
name: Scheduler sync test hardcoded-date time bomb
description: schedulerSyncIntegration.test.ts used hardcoded calendar dates as stand-ins for "past"/"future"; this has been fixed with Date.now()-relative helpers.
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

**Fix applied:** replaced all "nearby year" hardcoded dates throughout the
file with a relative helper block near the top:

```ts
const T0 = Date.now();
const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;
function rel(days = 0, hours = 0): string {
  return new Date(T0 + days * MS_DAY + hours * MS_HOUR).toISOString();
}
function relD(days = 0, hours = 0): Date {
  return new Date(T0 + days * MS_DAY + hours * MS_HOUR);
}
```

**Intentionally left as stable sentinels (not changed):**
- `FAR_PAST = "2000-01-01..."` / `FAR_FUTURE = "2999-01-01..."` — unambiguous extremes
- `"2020-01-01"` / `"2020-01-02"` in LAGS clock-skew tests — compare two old dates against each other, never against wall clock
- `CURSOR_C1 / CURSOR_C2` (`"2026-07-10..."` / `"2026-07-11..."`) — opaque cursor strings, never compared against now

**LWW ordering pitfall:** when a test has multiple sequential upserts that
must each win the LWW tiebreak over the previous one, use strictly
increasing rel() offsets. Example: `rel(-5)` → `rel(-3)` → `rel(-1)`.
Using decreasing values (e.g. `rel(-2)` then `rel(-3)`) makes the later
call lose the LWW, returning `"skipped"` instead of `"updated"`.

**How to apply:** if a scheduler-sync test starts failing with
`expected 'skipped' to be 'updated'` (or vice versa) with no related code
change, check whether the test's hardcoded `updatedAt` has been overtaken
by real time — the fix is now rel()-based helpers, already in place.
