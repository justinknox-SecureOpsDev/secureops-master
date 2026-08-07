---
name: Radio audio session must stay minimal
description: Bluetooth headset-mic audio-session options (iOS voiceChat/allowBluetooth, Android forced routing) garble ALL radio transmissions fleet-wide, headset or not.
---

The mobile radio's LiveKit audio session must stay minimal: the Android
`communication` preset plus iOS `defaultOutput: "speaker"`. Nothing else.

**Why:** an attempt to support Bluetooth headset MICS added, on iOS, an
`AudioSession.setAppleAudioConfiguration` override (`playAndRecord` +
`allowBluetooth`/HFP + `allowBluetoothA2DP` + `defaultToSpeaker` +
`mixWithOthers`, `audioMode: "voiceChat"`) and, on Android, a bluetooth-first
`preferredOutputList` + `forceHandleAudioRouting: true` + a `BLUETOOTH_CONNECT`
runtime prompt. It shipped to the fleet by OTA and made EVERY transmission
sound robotic/underwater to every listener with **no Bluetooth device involved
at all** — reported as "the radio is jumbled". `voiceChat` is Apple's
handset-tuned voice-processing path and fights WebRTC's own AEC/AGC/noise
suppression; forced routing pushes capture onto narrowband voice-call paths.
Reverted 2026-08-07; audio quality for the whole fleet outranks headset mics.

**How to apply:** if headset capture is revisited, engage those options ONLY
while a headset is actually the selected route (never as a static session
config), and verify on real hardware before an OTA. A regression test in
`radioMediaKeepAlive.native.test.ts` asserts the minimal config, no
`setAppleAudioConfiguration` call, and no Bluetooth permission prompt.

**Diagnostic shortcut:** "radio sounds robotic/underwater/muffled" is an
audio-session/routing problem on the CAPTURE side, not E2EE, not the SFU, not
the listen policy. Distinguish by symptom: static bursts at the start of a
press = E2EE cryptor readiness; overlapping/echo = duplicate rooms; robotic
throughout = session category/mode.

**Fleet-split gotcha:** the two platforms can sit on different runtime
versions, so one mobile fix needs TWO OTAs and the auto-OTA-on-deploy only
serves the newer runtime — the older fleet needs a manual push (mechanics in
`ota-update-from-sandbox.md`). Check both fleets' runtimes before assuming a
fix shipped.
