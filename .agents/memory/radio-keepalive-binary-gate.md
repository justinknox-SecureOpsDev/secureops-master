---
name: Radio locked-screen keep-alive binary gate
description: Why locked-screen radio audio needs a silent expo-audio keep-alive and which binaries have it
---

- iOS `UIBackgroundModes: audio` only prevents suspension while the audio unit is actually RENDERING. A quiet PTT channel has zero remote tracks, so iOS suspends the app ~30s after lock and the officer misses later transmissions.
- Fix: a silent looping expo-audio player runs while keep-alive demand exists (any listen room, connecting channel, active/starting publish); stops on leave/mute/teardown. `publishStarting` flag prevents mid-PTT flicker; `tearingDown` flag prevents a restart during sign-out.
- **Binary gate:** expo-audio natives are ABSENT from all store builds ≤ 10 — the guarded loader (`getExpoAudio()` in `nativeModules.ts`) returns null there and keep-alive silently degrades off. Locked-screen survival only works on binaries built with expo-audio (≥ 1.0.1 / build ≥ 11). An OTA push alone can NEVER deliver this fix.
- **Why:** "officers stop hearing radio when phone locks" on an old binary is expected degradation, not a JS bug — check the running binary's build number before debugging.
- **How to apply:** any new native-module dependency in the radio path must go through the `nativeModules.ts` guarded-loader + `BINARY_GATED_NATIVE_PACKAGES` pattern, ship in a new binary, and keep the OTA bundle safe on every older store build. Apple disclosure lives in APP_REVIEW_NOTES.md §3 and must stay in sync with the keep-alive's actual scope.

## The keep-alive + Bluetooth pair has been landed, pulled, and re-landed

This work has shipped twice. It went out in iOS build 14 (`1.0.1`), was stripped
back out of the repo hours later as "the broken radio", and was re-landed
verbatim for the `1.0.2` train.

**Why it is not purely a new-binary concern:** the keep-alive really is
binary-gated (harmless on old builds — `getExpoAudio()` returns null). The
**Bluetooth** half is NOT. It re-configures the shared `AVAudioSession` via
`AudioSession.setAppleAudioConfiguration` / `configureAudio`, and those LiveKit
APIs already exist in build 10 — so a JS-only OTA carrying the Bluetooth change
reaches the live `1.0.0` fleet and can alter or break audio there. That is the
most probable reason the pair was reverted together even though only one half
needed a new binary.

**How to apply:** never judge this pair by the test suite — nothing in CI can
prove locked-screen survival or headset routing. Ship to TestFlight and run
`RADIO_NATIVE_RELEASE_RUNBOOK.md` §4 on real hardware before releasing. If it
must be reverted again, revert the *Bluetooth* half first: it is the one with
blast radius beyond the new binary.

**Bumping the app version shrinks the Bluetooth blast radius to zero.** OTAs
target a runtime version, so once `expo.version` moved off `1.0.0` the legacy
fleet can no longer receive this JS at all. A runtime-pinned fleet is the
mitigation — no in-code kill switch is needed while the pin holds.

## Keep-alive demand must be tracked, not inferred

Every path that removes a demand source must reconcile, and an unexpected room
loss is a demand *transfer*, not a demand *end*. Both directions are real bugs
and they pull against each other:

- Reconcile too late (drop the room, never reconcile): if it was the last
  demand source the silent player loops forever with no radio connection —
  battery drain, a stuck background-audio indicator, and a direct
  contradiction of the App Review disclosure that it stops when the officer
  leaves the channel (Guideline 2.5.4 risk).
- Reconcile too eagerly (stop the player the instant the room drops): a
  transient network blip on a locked phone stops the audio unit, iOS suspends
  the app within ~30s, and a suspended app never runs its retry — the officer
  goes permanently deaf on exactly the blip the self-heal exists for.

**Why:** the resolution is to hold demand across the reconnect gap in an
explicit "recovering" set, entered only when a recovery listener is actually
registered, and cleared on re-listen, drop, teardown, or deregistration of that
listener. Demand then always has a bounded owner.

**How to apply:** when adding any new keep-alive demand source or any new way a
room can go away, add it to the demand predicate AND to every clear path. The
lifecycle is covered by `radioMediaKeepAlive.native.test.ts`; note that suite
has to register a Node `.wav` require handler, because Metro's asset `require()`
otherwise throws under vitest and the production try/catch swallows it, leaving
the player uncreated and every assertion vacuously green.
