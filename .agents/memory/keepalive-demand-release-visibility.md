---
name: Keep-alive demand must be visible to whatever releases it
description: Background-audio keep-alive leaks when an internal "demand" set is invisible to the API the UI uses to release demand.
---

# Keep-alive demand must be visible to whatever releases it

The native radio keeps a silent looping audio player alive whenever there is
listen or publish demand. Demand is the UNION of several internal sets — live
listen rooms, an active publish, and the `recovering` set (channels whose room
dropped and are awaiting an automatic reconnect).

**The rule:** every internal set that counts as keep-alive demand MUST be
enumerable through the same API the UI uses to release demand. In this codebase
the UI releases demand by iterating `listenChannelIds()` and calling
`dropListen()` on every id it no longer wants, so `listenChannelIds()` returns
the union of live rooms **and** recovering channels. `isListening()` is the
separate, narrower predicate meaning "audio is actually flowing".

**Why:** `recovering` was originally derived from live rooms only. After an
unexpected disconnect the channel had no room, so it vanished from
`listenChannelIds()` while still holding demand. If the officer then muted or
switched channel, the reconcile loop never saw it, `dropListen` was never
called, and the silent player looped forever — battery drain plus a direct
contradiction of the App Review 2.5.4 background-audio disclosure, which
promises audio stops when the user leaves. The bug is invisible in the happy
path: an explicit drop clears it, so only disconnect-then-abandon leaks.

**How to apply:** when adding any new state that makes `hasKeepAliveDemand()`
true, add it to the enumeration API in the same commit and add a test that
abandons the channel *without* an explicit drop (disconnect → mute/switch) and
asserts the player stops. A test that always calls `dropListen` explicitly will
pass against the leaky version and prove nothing.
