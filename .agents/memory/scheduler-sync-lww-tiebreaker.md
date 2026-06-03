---
name: Scheduler sync last-write-wins tiebreaker
description: How the inbound scheduler upsert decides skip-vs-apply, and what that means for tests.
---

# Scheduler sync conflict resolution depends on `syncSource`

`processInboundShift` / `processInboundClockEvent` (in `routes/schedulerWebhook.ts`)
delegate the skip-vs-apply decision to `shouldApplyInboundUpdate`, which branches
on the existing row's `syncSource`:

- **Row last written by the scheduler (`syncSource === 'scheduler'`)** → compare
  the incoming `updatedAt` against the stored **`externalUpdatedAt`** (the
  scheduler's own previous timestamp). Apply iff strictly newer. Both sides are
  on the scheduler's clock → immune to clock skew. This is the common case
  (re-pulls, reconciliation, out-of-order delivery).
- **Row last written locally (`syncSource === 'local'`, or no `externalUpdatedAt`)**
  → fall back to wall-clock: apply iff incoming `updatedAt` − local `updated_at`
  > 1 s. SecureOps wins ties so genuine local edits survive.

**Why:** The scheduler and SecureOps keep independent clocks. Comparing the
scheduler's `updatedAt` to SecureOps's wall-clock `updated_at` was only valid up
to the skew between them (ahead → stale updates win; behind → fresh ones wrongly
skipped). Comparing scheduler-vs-scheduler on `externalUpdatedAt` removes that.

**How to apply (tests):**
- Idempotency / "already synced re-pull is skipped": the first inbound write
  stamps `syncSource='scheduler'` + `externalUpdatedAt = payload.updatedAt`, so a
  second pull with the **same** `updatedAt` is skipped (not strictly newer).
  Past/future-dating no longer matters for the scheduler branch — equality skips.
- To exercise the **local-edit** branch, insert the row with `syncSource:'local'`;
  then a far-future payload applies and a far-past one is skipped (wall-clock).
- To exercise **clock-skew resistance**, insert `syncSource:'scheduler'` with
  `externalUpdatedAt` and `updatedAt` set to deliberately divergent times, then
  assert apply/skip follows `externalUpdatedAt`, not `updated_at`.
