---
name: In-flight 409 is a pending state, not a refusal
description: Why the replay-protection "still being processed" 409 must be told apart from route 409s by a machine-readable code, and how clients are expected to behave when they meet it.
---

The shared replay-protection middleware answers **409** in two unrelated
situations, and clients must not conflate them:

- **A route refusal** — "already assigned", "already fully staffed", "already
  paid". Nothing is happening; the request was rejected on its merits.
- **An identical keyed request is still running** — the middleware waited on
  the original, it did not finish in time, and this request is told so. Nothing
  was refused; the write is committing right now.

**Rule:** the in-flight case carries a stable `code` on the JSON body. Tell the
two apart by that code, never by matching the message prose.

**Why:** the message text is copy and will be reworded; a client that sniffs
for a substring silently starts calling real refusals "still saving" (or the
reverse) the day someone edits the sentence. The bug this fixed was the mirror
image — the portal rendered the in-flight 409 as a red failure next to the
button, so people pressed again or went hunting for a record that was landing.

**How to apply:**

- **Joining is safe, and is the point.** Re-sending the *same* key performs no
  work: it waits on the request already in flight and is answered from its
  record. So the right client response to an in-flight 409 is to go back and
  wait on it, which is how the caller settles on the real outcome instead of
  guessing.
- **Keep the two retry budgets apart.** Transient hosting-layer retries
  (429/502/503/504) mean *nothing happened*; in-flight joins mean *something
  is happening*. Sharing one allowance lets a slow write burn the budget that
  exists for restarts and cold starts.
- **Bound the joining by wall clock, not by a count** — the server blocks for
  its own wait on each join, so what matters is how long a person is asked to
  sit there, not how many round trips fit in it.
- **Unconfirmed is its own state.** When the budget runs out the write is
  neither done nor refused. Say exactly that, re-read the authoritative list so
  a write that did land shows itself, and leave the control usable — pressing
  again reuses the held key and can only replay. Never promise a result will
  appear on its own unless something is actually watching for it.
- **A dialog that mints its intent id on open must not rotate it while the
  last submit is unsettled.** Closing a dialog does not stop a write the server
  already has, so Cancel / Escape / the X followed by a re-open would otherwise
  hand the same creation a second key — a duplicate. Only a *definite refusal*
  (a 4xx from the route, not the in-flight 409, not 429, not a 5xx or a dropped
  connection) proves nothing was written and lets the intent be retired.
