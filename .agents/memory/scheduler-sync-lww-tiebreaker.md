---
name: Scheduler sync last-write-wins tiebreaker
description: How the inbound scheduler upsert decides skip-vs-apply, and what that means for tests.
---

# Scheduler sync conflict resolution compares against the LOCAL row's wall-clock `updatedAt`

`processInboundShift` / `processInboundClockEvent` (in `routes/schedulerWebhook.ts`)
compare the incoming payload's `updatedAt` against the **existing DB row's
`updatedAt` column** (the moment SecureOps last wrote the row), NOT against
`externalUpdatedAt`. Within 1 second → SecureOps wins → `skipped`.

**Why:** This is "last write wins where SecureOps gets the tiebreaker." A row
just created by SecureOps has `updatedAt ≈ now`, so the scheduler must report a
genuinely newer timestamp to override it.

**How to apply:** When writing integration tests that expect an inbound re-pull
of an *unchanged* record to be `skipped` (idempotency / "already synced"),
give the payload an `updatedAt` that is clearly in the **past** relative to the
test's wall clock (e.g. `"2025-01-01T..."`). A future-dated `updatedAt` will
re-apply as `updated` every time and never skip. The first create always
succeeds regardless (no existing row to tiebreak against).
