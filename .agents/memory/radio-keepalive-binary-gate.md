---
name: Radio locked-screen keep-alive binary gate
description: Why locked-screen radio audio needs a silent expo-audio keep-alive and which binaries have it
---

- iOS `UIBackgroundModes: audio` only prevents suspension while the audio unit is actually RENDERING. A quiet PTT channel has zero remote tracks, so iOS suspends the app ~30s after lock and the officer misses later transmissions.
- Fix: a silent looping expo-audio player runs while keep-alive demand exists (any listen room, connecting channel, active/starting publish); stops on leave/mute/teardown. `publishStarting` flag prevents mid-PTT flicker; `tearingDown` flag prevents a restart during sign-out.
- **Binary gate:** expo-audio natives are ABSENT from all store builds ≤ 10 — the guarded loader (`getExpoAudio()` in `nativeModules.ts`) returns null there and keep-alive silently degrades off. Locked-screen survival only works on binaries built with expo-audio (≥ 1.0.1 / build ≥ 11). An OTA push alone can NEVER deliver this fix.
- **Why:** "officers stop hearing radio when phone locks" on an old binary is expected degradation, not a JS bug — check the running binary's build number before debugging.
- **How to apply:** any new native-module dependency in the radio path must go through the `nativeModules.ts` guarded-loader + `BINARY_GATED_NATIVE_PACKAGES` pattern, ship in a new binary, and keep the OTA bundle safe on every older store build. Apple disclosure lives in APP_REVIEW_NOTES.md §3 and must stay in sync with the keep-alive's actual scope.
