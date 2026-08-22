---
name: Durable idempotency store design
description: Why the retry-safety store for non-idempotent writes moved from an in-memory Map to Postgres, and the invariant that must survive any future change to it.
---

The outcome of a keyed write (create shift, roster an officer, approve a time
entry) is recorded so a retry after an interrupted request replays instead of
repeating the work. An in-memory-only record is erased by a redeploy/crash
between the interrupted request and its retry, or when the retry lands on a
second API instance — either way the caller is back to "I cannot tell you
whether that went through".

**The fix:** a durable row per claim (primary key = a hash of actor+method+
path+key) is the single source of truth; an in-process map of in-flight
promises is only a same-process fast path, never the record of truth. Clearing
it (e.g. to simulate a restart in tests) must never lose an answer the
database still has.

**The invariant that must never regress:** nothing may be told "this outcome
is recorded/replayable" — not a client response, not an in-process replay
promise — until the durable write has actually succeeded. Sending that answer
on a timeout, or as a same-process short-circuit, ahead of the durable write
lets one waiter believe the action replayed while a process restart moments
later shows the same claim still unresolved: two truths that can never both be
right. A claim with no outcome yet must never be swept/evicted either, no
matter how old or how full the store is — capacity pressure refuses new keyed
writes instead. If persisting an outcome keeps failing after retries, leave
the claim unresolved and answer honestly ("still being processed") rather than
claim a replay safety that was never durably earned.

**Why:** an old version of this file's own header comment said "in-memory on
purpose" — if that phrase resurfaces, or any response claims a replay outcome
before its matching durable write is confirmed, this guarantee has regressed.
