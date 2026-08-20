---
name: One-open-time-entry-per-officer invariant
description: A partial unique index enforces one open time entry per officer; every insert path (and test fixture) must expect a 23505 conflict.
---

An officer may have at most one open `time_entries` row (`clock_out_time IS NULL`). This is now enforced **both** in application code and by a partial unique index on `employee_id WHERE clock_out_time IS NULL`.

**Why:** the original self clock-in used a bare check-then-insert, so two concurrent requests could both pass the check. Application locking fixed the known paths, but nothing stopped a *future* path from skipping the lock — the index is the backstop.

**How to apply:**
- Any new insert into `time_entries` with a null clock-out can raise `23505`. Translate it into that path's existing "already clocked in" answer (manual → 400, auto → `triggered:false`, dispatch on-behalf → 409, scheduler inbound → skipped), never a 500. Use the shared conflict helper in api-server's lib, which matches on the index name so unrelated unique violations (e.g. the scheduler external-id index) still surface as real errors.
- Drizzle wraps driver errors ("Failed query: …") and hangs the pg error off `cause` — conflict detection must walk the `cause` chain, not just the top-level object.
- Clock-in paths should still serialize per officer (`SELECT … FOR UPDATE` on the officer's `users` row inside the transaction) so the normal case returns a clean message rather than relying on the index.
- **Test fixtures** that seed two open entries for one officer now fail with 23505. Seed the second open row under a *different* officer, or close the first one.
