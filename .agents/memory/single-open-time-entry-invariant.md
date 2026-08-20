---
name: One-open-time-entry-per-officer invariant
description: One open time entry per officer is enforced in the database as well as in code; every insert path must expect a losing race, not a 500.
---

An officer may have at most one open `time_entries` row (no clock-out). This is
enforced **both** in application code and by a database uniqueness constraint.

**Why:** the original self clock-in used a bare check-then-insert, so two
concurrent requests could both pass the check. Application locking fixed the
known paths, but nothing stopped a *future* path from skipping the lock — the
database constraint is the backstop.

**How to apply:**
- Any new insert of an open time entry can lose the race. Translate that
  conflict into whatever "already clocked in" answer that path already gives,
  never a 500 — use the shared conflict helper rather than matching errors
  yourself, since the driver error is wrapped and easy to mis-detect.
- Clock-in paths should still serialize per officer inside the transaction so
  the normal case returns a clean message instead of relying on the constraint.
- Test fixtures that seed two open entries for one officer now fail. Seed the
  second open row under a different officer, or close the first one.
