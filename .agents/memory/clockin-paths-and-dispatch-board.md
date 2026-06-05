---
name: Clock-in attach paths & dispatch status-board sourcing
description: The multiple clock-in shift-attach paths that must share the time-window policy, and why the dispatch board's onDuty must mirror dashboard clockedInNow.
---

# Clock-in attach paths must share the time-window policy

There are THREE places a non-admin clock-in can attach to a specific shift, and a time/date policy must be applied consistently across them or it is bypassable:

1. **Explicit shiftId** (officer taps a shift) — guarded by `clockInWindowRejection`.
2. **Manual site-picker** (`bodySiteId` → `officerRosteredShiftsForPicker` → `closestByStart`) — the GPS-less fallback. Its eligibility query has **no early bound** (returns rostered shifts up to a far-future cutoff), so it MUST also call `clockInWindowRejection` before attaching, or an officer clocks into a shift days out by picking its site.
3. **GPS auto-attach** (`resolveOrAssignShiftForAdHocClockIn`) — intentionally NOT given the 30-min guard because it is *already* time-bounded to `±SHIFT_MATCH_GRACE_MS` around now AND requires physical presence (GPS). Leave it alone.

**Window policy (product decision):** opens 30 min before scheduled start, stays open until scheduled end. Late clock-ins ALLOWED (flagged "late" on the board); early/wrong-date BLOCKED with 409. Admins bypass entirely (they fix records / cover via the dispatch on-behalf endpoint).

**Why:** officers were clocking into wrong-date shifts (e.g. a July-4 shift in June), which polluted the dispatch board and time records.

**How to apply:** any NEW path that creates/attaches a clock-in to a shift for a non-admin must route through `clockInWindowRejection` (or be inherently time-bounded like the GPS path).

# Dispatch status-board onDuty must mirror dashboard clockedInNow

`GET /dispatch/status-board`'s `onDuty` bucket must be built from **all open time entries** (`clockOutTime IS NULL`), NOT from an accepted-assignment-in-today's-window join. Coupling onDuty to the assignment-window join silently drops officers clocked into an out-of-window shift, so the board's "clocked in" count diverged from `dashboard.ts` `clockedInNow`.

**Skip-to-avoid-double-count is per `(userId, shiftId)`, not per `userId`.** Skipping all of a clocked-in officer's assignment rows globally hides a legitimate *second* shift later the same day. Skip the assignment row only when an open entry matches that exact `(userId, shiftId)`; for open entries with NULL shiftId (ad-hoc/billing-only) you can't disambiguate, so fall back to skipping that user's rows entirely.
