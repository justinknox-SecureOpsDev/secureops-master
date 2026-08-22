---
name: Assistant write idempotency
description: How replay protection for assistant-dispatched writes is shaped, and the two traps that silently break it.
---

The portal assistant performs real writes by dispatching a loopback HTTP
request to the app's own route as the signed-in user. When that answer is lost
the write may already have committed, so the write needs a caller-supplied
idempotency key before any retry is safe.

## Rule 1 — the reconciling retry must live inside the dispatch call

Do NOT implement "try again" as a second approve/POST from the client or the
route above.

**Why:** the assistant's pending action is single-use — claiming it deletes it,
and a test asserts a second approve is 404. A retry outside the dispatch has
nothing left to claim. The retry belongs in the dispatcher, bounded to one
extra send, and only when a key was supplied.

**How to apply:** any new "resend on unknown outcome" behaviour goes next to
the send, not next to the approval gate.

## Rule 2 — never evict a pending key entry when the socket closes

The replay cache records the handler's outcome at `res.json`, i.e. *before* it
reaches the wire, and deliberately does not listen for the response `close`
event.

**Why:** a client hanging up mid-request is exactly the case the cache exists
for. The handler is usually still running and about to commit. Evicting on
`close` frees the key, the retry re-runs the route, and the change is applied
twice — the precise bug the mechanism was built to prevent.

**How to apply:** eviction happens on `finish` only (nothing recorded, or a
>=400 outcome so the caller can fix and retry). A key whose original never
answers stays pinned until TTL, and a retry against it is told "still being
processed" rather than being allowed to duplicate. That is intentional: an
honest stall beats a silent double-write.

## Rule 3 — "replayed" and "re-performed" are different stories

The response carries a replay marker so the caller can tell which happened:

- replayed → the server recognised the key; the *first* attempt committed and
  the route did not run again.
- re-performed → the first attempt never committed; this send did the work.

Both mean exactly once, but only the first can honestly be reported as "it had
already gone through". Collapsing them into one message loses information the
person actually needs.

## Related

Payroll's mark-paid and PNC routes carry their own older, in-route version of
the same idea (body field `idempotencyKey`, replay flag in the body). It is a
separate implementation on separate routes — changing one does not change the
other.
