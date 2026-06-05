---
name: api-server WS broadcast suite flake (FIXED)
description: wsBroadcast.test.ts used to flake only under the full parallel run; now deterministic via an event-driven collector. Don't reintroduce fixed-window sleeps.
---

`artifacts/api-server/src/__tests__/wsBroadcast.test.ts` previously passed alone
but flaked under the full parallel suite (`pnpm --filter @workspace/api-server
test`), typically `expected [] to have a length of 1`.

**Root cause:** the test collected WS frames with a fixed `collectFor(ws, 500)` /
`250` window after issuing the POST. Under full-suite CPU/import load the
broadcast frame could arrive after the window closed, so a real, correct
broadcast read as zero. It was a test-timing problem, never a server regression.

**Fix:** replaced the fixed-window collectors with `collectBroadcast(subjects,
match, expected, trigger)`. It arms message listeners BEFORE firing the POST,
resolves as soon as every subject EXPECTED to receive (`expected` map keyed by
user id / key) has its frames — bounded by a generous deadline — then waits a
short settle window so any erroneous over-delivery to a should-receive-nothing
subject still surfaces. Server fan-out is one synchronous loop, so a leak frame
travels the same loopback hop and lands inside the settle window.

**How to apply:** do NOT reintroduce flat `setTimeout` collection windows in
this file or new WS broadcast tests — gate on an expected frame count instead.
If a WS broadcast test ever flakes again, reproduce in isolation first; if it
passes alone it's still a timing/coordination issue, not a scoping bug.
