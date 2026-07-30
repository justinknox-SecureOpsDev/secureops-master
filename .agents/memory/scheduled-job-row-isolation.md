---
name: Scheduled jobs — per-row isolation and capped computed values
description: Why batch jobs that loop over rows must try/catch per row and clamp any duration/amount they compute before writing.
---

# Scheduled jobs: isolate per row, cap what you compute

Two rules for any scheduled job that loops over DB rows and writes a computed
value (auto-clock-out is the reference case, but this applies to payroll
sweeps, invoice locking, reminder escalation — anything with the same shape):

1. **Wrap the per-row work in its own try/catch.** A single throw inside the
   loop aborts the whole tick, so every row ordered after the bad one is
   silently skipped — forever, because the same row throws on the next tick too.
2. **Clamp any duration/amount derived from wall-clock time before writing it.**
   "now() minus a timestamp that was never closed" is unbounded.

**Why:** an officer's time entry was left open ~420 days *and* had a clock-in
later than its shift's scheduled end, so the job's "fall back to now()" branch
computed a five-figure hours value. `time_entries.hours_worked` is
`numeric(6,2)` (max 9999.99), so the write threw — and because the throw
escaped the loop, **no officer anywhere got auto-clocked-out**. One corrupt row
disabled the feature fleet-wide, and the only symptom was a log line.

The money angle matters as much as the crash: `hours_worked` feeds payroll and
invoicing directly, so widening the column would have been the *wrong* fix — it
would have turned a loud crash into a silent five-figure payout. Cap instead,
and mark the row for human review.

**How to apply:** when the cap trips, keep the written timestamp and the written
duration consistent with each other (`hours == clockOut - clockIn`), because
analytics recomputes hours from the timestamps in some queries while payroll
reads the stored column — if they disagree the two surfaces silently diverge.
Set the cap above any legitimate value (a 24h security post with an early
clock-in is real) so it only ever catches corrupt data.

Related: nothing enforces one-open-time-entry-per-officer at the DB level, so
stale open entries are always possible — see `single-open-time-entry-invariant.md`.
A stale open entry also blocks that officer from clocking in again, so these
rows are user-visible, not just cosmetic.

**Known gap:** auto-clock-out INNER JOINs shifts, so an ad-hoc clock-in with no
`shift_id` is never swept — it stays open indefinitely and keeps blocking that
officer. Closing those needs a different rule (they are legitimately open while
in progress), so it is a policy decision, not a bug fix.