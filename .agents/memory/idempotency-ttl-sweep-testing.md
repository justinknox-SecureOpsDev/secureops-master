---
name: Idempotency TTL sweep testing
description: How to test that idempotency.ts actually deletes expired/unresolved rows, not just caps them
---

`artifacts/api-server/src/lib/idempotency.ts`'s `sweep()` only deletes rows with a
non-null `status` (a recorded outcome) past `expiresAt`. A row still claimed
(`status: null`, write in flight) is NEVER swept, no matter its age — that's
deliberate (an unresolved claim might be one instant from committing).

To prove a swept/released row is genuinely gone (not just capped-and-hidden),
don't just check the *same* key stops replaying — that can pass even if the
row was merely re-claimed via the `onConflictDoUpdate` path. Instead, shrink
`maxEntries` to 1 via `setIdempotencyLimitsForTests` and show a **different,
unrelated** key can claim the sole slot only after the first entry's TTL (or
release) has passed. If the expired/released row were still counted, the
unrelated key would still get the 503 capacity refusal.

**Why:** a regression that leaves `sweep()`/`res.on("finish")` cleanup silently
no-op-ing (e.g. wrong `status` predicate, or a swallowed delete error) can hide
behind a same-key reuse test but not behind a capacity test with a fresh key.

**How to apply:** when adding idempotency-store tests, prefer the
capacity-with-an-unrelated-key pattern over same-key-replay checks whenever
the claim is "this row was actually deleted from the store."

Also: `releaseClaim` on the `res.on("finish")` fire-and-forget cleanup path
(handler answered via `res.send`/`res.end`, not `res.json`) is NOT retried if
the delete itself throws — the row is left permanently unresolved (`status:
null`), which `sweep()` will never touch. A single transient DB error during
that cleanup can jam a key forever. Filed as a follow-up rather than fixed;
if touching this file again, check whether it's been addressed.
