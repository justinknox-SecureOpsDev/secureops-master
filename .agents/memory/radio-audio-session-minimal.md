---
name: Radio BT headset — conditional audio-session and detection invariants
description: Invariants for the SecureOps radio Bluetooth HFP support: what must never be set globally, how detection triggers, what drives routing, and why native listener registration must be lazy.
---

## Audio-session invariants (never violated)

- **Never `voiceChat` mode** (iOS) — it activates Apple's handset voice-processing
  path, which fights WebRTC's AEC/AGC/noise-suppression and makes every
  transmission sound robotic/underwater for ALL listeners, headset or not.
  `videoChat` (or the default) is the correct mode.

- **Never `allowBluetooth`/`allowBluetoothA2DP` as a static session config**
  (iOS) — those options must be set ONLY while a BT HFP device is actually the
  selected route (`isBluetoothHFPActive` true); removing them on disconnect is
  mandatory. A static override degrades ALL transmissions.

- **Never `forceHandleAudioRouting: true`** (Android) — forces capture onto the
  narrowband voice-call path, degrading audio for every user regardless of
  headset presence.

- **Never `configureAudio({ preferredOutputList })` post-session-start**
  (Android) — `preferredDeviceList` is constructor-only in `AudioSwitchManager`;
  it has no effect on the running instance. Use `selectAudioOutput("bluetooth")`
  / `selectAudioOutput("speaker")` on the live instance instead.

## Detection and routing invariants

- **Availability triggers; active-route confirms.**
  `hasBluetoothHeadsetAvailable` (Android: `getDevices()` type integers;
  iOS: `availableInputs`) is the trigger for the lazy permission request and
  `selectAudioOutput("bluetooth")` call. `isBluetoothHFPActive` (Android:
  `getCommunicationDevice().type` / `isBluetoothScoOn()`; iOS:
  `currentRoute.inputs`) is the confirmation that routing actually changed.
  Android branches on availability; iOS branches on active-route (iOS
  auto-routes, so they arrive together).

- **Permission is lazy.** `requestBluetoothPermission()` (Android 12+ /
  API 31+) is called only the first time `hasBluetoothHeadsetAvailable`
  transitions false→true. Officers with no headset never see the prompt.
  A denied permission must NOT cause a re-prompt loop; the route stays on
  speaker and disconnect events skip `selectAudioOutput` (route was never
  changed).

- **Revert guard.** If `BLUETOOTH_CONNECT` was denied, disconnect must not
  call `selectAudioOutput("speaker")` — the baseline route was never changed.

## Native listener registration must be lazy

`appContext.reactContext` can be null when an Expo module's `OnCreate` fires
(module instantiated before the React host is fully live). Route-change
listeners that require `audioManager` (which requires `reactContext`) must be
guarded by a lazy `ensureRouteListenersRegistered()` call:

- **Idempotency flag** (`@Volatile listenersRegistered`) — registration runs
  at most once per module lifecycle.
- **Call sites**: `OnCreate` (eager attempt), `OnStartObserving("onAudioRouteChange")`
  (fires when JS first adds an event listener — `reactContext` is guaranteed
  live at this point), and every `Function`/`AsyncFunction` entry point.
- **OnDestroy resets the flag** so a module-recreate cycle can re-register.

Symptom of missing lazy guard: connecting a headset AFTER a radio session
starts produces no permission prompt and no BT routing — the three
route-change signals (AudioDeviceCallback, OnCommunicationDeviceChangedListener,
SCO broadcast) were never registered.

## Diagnostic shorthand

"Radio sounds robotic/underwater/muffled" → audio-session/routing problem on
the CAPTURE side (wrong mode, static BT options). NOT E2EE, NOT the SFU, NOT
the listen policy. Distinguish: static bursts at press start = E2EE cryptor
readiness; overlapping/echo = duplicate rooms; robotic throughout = session
category/mode.
