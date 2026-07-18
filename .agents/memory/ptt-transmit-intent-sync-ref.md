---
name: PTT transmit-intent must be a synchronous ref
description: Why push-to-talk publish gating must use a synchronous intent ref + generation, never React state or useEffect-mirrored refs
---

For press-and-hold / realtime "am I still transmitting?" gating, the authoritative
signal MUST be a **synchronous** ref written the instant the user presses and
cleared the instant they release — not React state and not a ref mirrored from
state via `useEffect`.

**Why:** React state and `useEffect`-mirrored refs lag by at least a tick. A
WebSocket echo (e.g. the server's `speaking` lock-grant) can arrive in that gap,
so a handler gating on `talkStateRef.current === "requesting"` (mirror) or on
`talkState` still sees the pre-release value and starts publishing AFTER the user
let go — leaking microphone audio outside the intended hold window. A fast
press/release can even run the stop handler from a render where state is still
"idle", skipping cleanup entirely. Took 3 architect rounds to fully close.

**How to apply (the pattern that passed review):**
- `transmitGenRef` (number) bumped on every start AND stop/cancel.
- `transmitIntentRef = { channelId, gen } | null`: set synchronously in
  `startTalking()` BEFORE sending the WS `start`; nulled synchronously in
  `stopTalking()` and `cancelTransmit()` BEFORE any async teardown.
- The WS lock-grant handler publishes ONLY if `transmitIntentRef.current` is
  non-null and matches; it passes `intent.gen` into the publish path.
- The publish path's abort check is `transmitGenRef.current !== gen` re-evaluated
  after every async step (token fetch, connect, track create, publishTrack).
- `stopTalking()` gates on `transmitIntentRef.current` (NOT React `talkState`),
  so a fast press/release still runs full cleanup + sends WS `end`.
- The media layer's abort/teardown must operate on the **local** room/track
  handles captured for that attempt, clearing instance refs only if they still
  point at this attempt — so a concurrent stop (refs nulled) still disconnects
  the room that finished connecting, and a newer transmit is never stomped.
