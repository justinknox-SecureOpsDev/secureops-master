---
name: One-open-time-entry-per-officer invariant
description: There is no DB-level uniqueness enforcing a single open time entry per officer; clock-in paths must guard concurrency themselves.
---

The system assumes an officer has at most one open `time_entries` row (`clock_out_time IS NULL`) at a time, but **there is no DB constraint enforcing it**. Every clock-in path enforces it only in application code.

**Why:** the original self clock-in (`timeEntries.ts`) uses a bare check-then-insert (no tx/lock), so two concurrent clock-ins for the same officer can both pass the check and create two open entries. Without a unique constraint, nothing at the DB level stops this.

**How to apply:**
- New on-behalf/admin clock-in paths should serialize per officer — take a `SELECT ... FOR UPDATE` row lock on the officer's `users` row inside a transaction, re-check for an open entry, then insert; return 409 on conflict. (This is what the dispatch admin clock-in does.)
- Any clock-out fallback that picks "the open entry" without an explicit id must order deterministically (e.g. most-recent `clockInTime`) so bad data never closes an arbitrary row.
- If you ever want a hard guarantee, add a partial unique index `UNIQUE (employee_id) WHERE clock_out_time IS NULL` — but then the existing self clock-in must catch the `23505` and return a clean 400 instead of a 500.
