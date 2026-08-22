---
name: Idempotency key — client policy
description: How admin-portal clients mint, hold and rotate an Idempotency-Key, and which duplicate hazards a key actually removes.
---

# One key per user intent

The API's replay protection is opt-in per route and keyed by
`userId:METHOD:path:<key>`. A client only gets protection if it sends the SAME
key for what the person meant as ONE action.

**Rule:** mint the key when the user commits to an action, hold it against an
intent id, rotate it only **after a success** (with a ~2 s retention so a
lagging duplicate still replays), and **never rotate after a failure**.

**Why:** a failed attempt is exactly the case where nobody knows whether the
write landed — a dropped connection may have committed it — so the retry must
carry the same key to find out. Keeping the key after a *refusal* is safe
because the server evicts any recorded outcome with status ≥ 400, so reuse
simply performs the work.

**How to apply:** intent ids must distinguish two things the user could
legitimately want in a row — include the row id AND the decision
(`entry:approved` vs `entry:rejected`), the shift AND the officer. A dialog
that can create the same thing twice on purpose should mint a fresh intent per
opening, not derive the id from the form contents.

# A key makes a write retry-eligible

Unkeyed writes must never be auto-retried on 429/502/503/504 (the answer being
lost does not mean the work was). With a key, a retry can only replay or
complete, so the shared HTTP helper is allowed to retry it.

# What a key does and does not buy

React already blocks the naive double-click: the state set in the click
handler flushes before the second click, so the button is disabled. The
duplicate hazards a key actually removes are the ones no `disabled` prop
covers — a retry of an unanswered request, a browser/proxy replay, and submit
paths with no button at all (drag-and-drop rostering).

**Watch for naturally-idempotent routes:** the repeating-shift endpoint skips
occurrences that already exist per (position, start time), so a duplicate
series submit creates nothing. Check for that kind of skip logic before
treating a write as unprotected.

**A client key window is not a duplicate guard.** The held key only spans the
couple of seconds after a success, so a repeat that arrives later (stale list
still reading "pending", a second admin's tab, a phone that was offline)
carries a *fresh* key and reaches the handler as a new request. For a write
whose re-run costs real money — a time-entry decision re-stamps the approval
and re-rolls the hours into payroll and the client invoice — the route must
also refuse to move a row into the state it is already in, and answer with the
row as it stands rather than an error.

**Why:** the two layers answer different questions. The key answers "did my
interrupted request land?"; the state guard answers "is this press a decision
at all?". Neither substitutes for the other, and a `disabled` button
substitutes for neither.

**How to apply:** define the no-op as *exactly* already-in-target-state
(status, verified flag, hours, notes, no pending confirmation to clear) so a
correction, a reversal, or a force-clear still runs.

**And a read-then-write state guard is not a guard either.** Two presses can
clear the "is it already decided?" check at the same instant — both read
`pending`, both update, both re-run the side effects. The transition itself has
to be the guard: a *conditional* update whose predicate carries the state that
was read (`WHERE id = ? AND status = <as read> AND decidedAt IS <as read>`).
The request that updates zero rows lost the race; it re-reads, finds the row
already in the target state, and answers from the winner's row without touching
payroll or the invoice. Re-attempt at most once more, then 409 rather than
overwrite whoever is actively editing.

**Why:** a nullable "when was this last decided" timestamp doubles as the row's
version column whenever every successful transition re-stamps it, so the claim
needs no schema change. Under READ COMMITTED the loser's UPDATE blocks on the
winner's row lock and re-evaluates the predicate against the committed row, so
its follow-up read is guaranteed to see the winner — no polling, no retry loop.

**How to apply:** put the expensive side effect strictly after a non-empty
`RETURNING`, never before or beside it. To prove it, fire N concurrent requests
with *distinct* keys (distinct actors make the winner observable) and assert
every response describes the same stamp; if the race doesn't manifest, raise N
rather than weaken the assertion.
