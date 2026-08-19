---
name: Scheduled jobs — row isolation, capped values, and retryable delivery
description: Why batch jobs need per-row isolation, bounded computed values, and retry-safe claims for external delivery.
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
3. **A pre-delivery claim is not a success marker.** When an atomic
   `UPDATE … RETURNING` claim precedes notifications, persist the complete
   in-app delivery batch atomically. If persistence fails, release the claimed
   rows for retry; otherwise a transient write failure permanently suppresses
   the alert. Send best-effort device pushes only after the durable in-app rows
   exist, so an ambiguous provider response cannot create duplicate history.

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

For notification sweeps, build all recipient groups after claiming. Treat
eligibility-query failures as retryable per row, and treat the in-app batch as
all-or-none before attempting push-provider delivery.

Related: nothing enforces one-open-time-entry-per-officer at the DB level, so
stale open entries are always possible — see `single-open-time-entry-invariant.md`.
A stale open entry also blocks that officer from clocking in again, so these
rows are user-visible, not just cosmetic.

**Turning a global constant into per-entity config:** the job's SQL pre-filter
usually encodes the old constant (`WHERE end_time <= now() - 10min`). Once each
site can set its own wait, that filter silently excludes every site whose value
is *longer* than the old constant — those rows never enter the loop, so the
feature looks like it "just doesn't run" there. Widen the query to the loosest
bound the config allows (here: "the shift has ended at all") and evaluate the
per-row threshold in JS, where the clamp also lives. Rows with no linked entity
must fall back to the documented default, not be skipped.

**Known gap:** auto-clock-out INNER JOINs shifts, so an ad-hoc clock-in with no
`shift_id` is never swept — it stays open indefinitely and keeps blocking that
officer. Closing those needs a different rule (they are legitimately open while
in progress), so it is a policy decision, not a bug fix.
