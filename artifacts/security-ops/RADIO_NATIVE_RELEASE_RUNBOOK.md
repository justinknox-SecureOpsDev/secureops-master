# Native Release Runbook — Live Push-to-Talk Radio

This runbook covers shipping the **live PTT voice radio** feature to the mobile
app. Unlike the multi-org change (see `OTA_RELEASE_RUNBOOK.md`), this feature
**cannot** ship over-the-air.

## ⛔ Why this is a NEW native build, not an OTA update

Live radio adds **new native modules** to the binary:

- `@livekit/react-native` + `@livekit/react-native-webrtc` (the WebRTC media stack)
- `expo-audio` (the silent keep-alive player that stops iOS from suspending the
  app on a quiet channel when the phone locks — see "Locked-phone survival" below)
- iOS `UIBackgroundModes: ["audio"]` + `NSMicrophoneUsageDescription`
- Android `FOREGROUND_SERVICE_MICROPHONE` + the LiveKit/WebRTC config plugins

`expo-updates` (OTA) can only swap the **JavaScript bundle** — it cannot add
native code or new OS permissions.

### Which binaries have which natives

| iOS store build | `expo.version` / runtime | LiveKit natives | `expo-audio` | `audio-route` (local) |
| --- | --- | --- | --- | --- |
| 1 – 9 | `1.0.0` | ❌ | ❌ | ❌ |
| 10 | `1.0.0` | ✅ | ❌ | ❌ |
| 14 | `1.0.1` | ✅ | ✅ | ❌ |
| 15+ (this release) | `1.0.2` | ✅ | ✅ | ✅ |

`audio-route` is the **local Expo module** (`modules/audio-route/`) added in this
build for iOS AVAudioSession route-change detection. Its `requireNativeModule`
call throws `CannotFindNativeModule` on any binary that predates it; the lazy
loader (`getAudioRoute()`) catches that and returns null — BT monitoring is
disabled, radio continues unchanged on old binaries.

Most officers are on build 10 (runtime `1.0.0`). That is why every native
package the radio JS touches is loaded through a guarded lazy require — a
`1.0.0` OTA bundle must not crash on a binary that lacks the module.

### ⚠️ Build 14 history — read before shipping this again

Build 14 (`1.0.1`) was cut on 2026-07-25 **from the same keep-alive + Bluetooth
code this release ships**. Hours later that work was stripped back out of the
repo and an OTA of the July-22 engine was pushed to the `1.0.0` fleet, and
`app.json` was pinned back to `1.0.0`. The recorded reason is that build 14
"embeds the broken radio".

The most likely mechanism: the Bluetooth change re-configures the shared
`AVAudioSession` (and Android routing) through LiveKit calls that **build 10
already has**, so it reached the live `1.0.0` fleet over OTA and affected
audio there — not only in the new binary.

**Consequence for this release: the build must be exercised on a real device
via TestFlight BEFORE it is released to the App Store.** Do not treat a green
test suite as sufficient; nothing in CI can prove locked-screen survival or
Bluetooth routing.

### Locked-phone survival (why the silent keep-alive exists)

`UIBackgroundModes: audio` only prevents iOS suspension while the audio unit is
**actually rendering**. On a quiet PTT channel there are zero remote tracks
(each transmission is a short-lived publisher room), so iOS suspends the app
~30 seconds after the screen locks and the officer silently misses every later
transmission. `radioMedia.native.ts` therefore loops a silent wav
(`assets/audio/silence.wav`) via `expo-audio` for exactly as long as there is
real radio demand (`reconcileKeepAlive()`), and `RadioScreen.tsx` re-reconciles
the listen room, the control WebSocket, and the keep-alive player on return to
foreground.

---

## 0. Server prerequisite (do this first)

The radio token endpoints fail closed with **HTTP 503** (and the app degrades to
presence-only) unless the API deployment has LiveKit Cloud credentials. On the
**production API deployment**, set:

| Secret | Source |
| --- | --- |
| `LIVEKIT_URL` | LiveKit Cloud project (the `wss://…` URL) |
| `LIVEKIT_API_KEY` | LiveKit Cloud project API key |
| `LIVEKIT_API_SECRET` | LiveKit Cloud project API secret |

These are already present in the dev environment. Confirm they exist in
production **before** submitting the build, or reviewers/first users will see
"Live audio is not configured on this server."

> No media ever touches our servers and **nothing is recorded** — audio rides
> per-channel, end-to-end-encrypted LiveKit rooms. The `/api/ws/radio` socket
> remains the control plane only (membership, the single-speaker lock, presence,
> and audit metadata).

---

## 1. Version + OTA targeting

`app.json` `expo.version` is **`1.0.2`** for this release. `runtimeVersion.policy`
stays `appVersion`, so the new binary's runtime is `1.0.2`. The iOS
`buildNumber` / Android `versionCode` are managed by EAS (`eas.json` →
`appVersionSource: "remote"` + `production.autoIncrement: true`) — never edit
those by hand.

> **OTA policy change (owner justin.knox, 2026-07-28):** the previous standing
> rule pinned `expo.version` to `1.0.0` so every OTA reached the store-build-≤10
> installed base, and explicitly forbade cutting a production native build while
> that pin was in place. The owner has now approved moving to `1.0.2` and cutting
> this build, accepting that officers must update from the App Store. From this
> release, OTAs target runtime **`1.0.2`**; the `1.0.0` fleet stops receiving
> them once officers move over.
>
> ⚠️ Until officers actually update, the `1.0.0` fleet is live and unserviced.
> Do not push a JS-only fix expecting it to reach them.

> **July 2026 lesson (still applies):** the repo once sat at `1.0.1` while every
> live store build was runtime `1.0.0`, so every auto-OTA-on-deploy published to
> a runtime nobody had and NO installed device received updates. Never bump
> `expo.version` for an OTA-only release — confirm the live runtimes with
> `eas build:list` before publishing.

### Binary-gated native packages (enforced by a test)

The list of native packages that are missing from some served binaries lives
in `components/radio/nativeModules.ts` → `BINARY_GATED_NATIVE_PACKAGES`,
together with the only files allowed to `require()` each of them:

| Package | Present in | Guarded loader |
| --- | --- | --- |
| `@livekit/react-native` | build ≥ 10 | `components/radio/nativeModules.ts` (`getLiveKitNative()`) |
| `@livekit/react-native-webrtc` | build ≥ 10 | `components/radio/nativeModules.ts` (`getLiveKitWebRTC()`) |
| `expo-audio` | build ≥ 14 | `components/radio/nativeModules.ts` (`getExpoAudio()`) |
| `audio-route` (local) | build ≥ 15 (this release) | `components/radio/nativeModules.ts` (`getAudioRoute()`) |
| `livekit-client` | every binary (JS-only) — but see below | `components/radio/nativeModules.ts` (`getLiveKitClient()`) |

> **Why `livekit-client` is gated even though it ships in every bundle:** it is
> pure JS, but its MODULE EVALUATION references browser globals (`DOMException`,
> …) that Hermes only has after `@livekit/react-native`'s `registerGlobals()`
> has run. A static value import therefore threw
> `ReferenceError: Property 'DOMException' doesn't exist` on EVERY native
> binary (and Expo Go) before any runtime guard could execute, killing module
> registration for the Radio/Chat/Live-Map routes — release builds crashed to
> the springboard, dev bounced back to the home screen. `getLiveKitClient()`
> forces `getLiveKitNative()` (and its `registerGlobals()`) first and returns
> `null` when the natives are absent. Only `import type` from `livekit-client`
> is safe at the top level of OTA-updatable code.

`__tests__/binaryGatedNativeImports.test.ts` scans every bundled source file
and **fails the workspace test gate** if one of these packages is statically
value-imported, value re-exported, or `require()`/`import()`ed outside its
approved loader (type-only imports are fine — they're erased at compile time).

**When you add a new native dependency** that OTA-updatable code touches:
either add it to `BINARY_GATED_NATIVE_PACKAGES` with a guarded lazy loader
that degrades gracefully, or bump `expo.version` (a real runtime bump, §1) so
old binaries never receive bundles that reference it. Once ALL served binaries
contain a package (after a forced-update cycle), it can be removed from the
list and imported normally.

## 2. Production build

```bash
cd artifacts/security-ops
EAS_NO_VCS=1 npx eas build --profile production --platform ios --non-interactive --no-wait
```

`EAS_NO_VCS=1` is **mandatory** in this sandbox: the default VCS archiver ships
`git HEAD`, so uncommitted working-tree fixes would be silently omitted and you
would rebuild the previous bug. It also avoids the blocked git index writes.

Builds take far longer than one command window — start with `--no-wait`, then
poll `eas build:list --platform ios --limit 1` on later turns.

## 3. Upload to App Store Connect (TestFlight)

```bash
cd artifacts/security-ops
pnpm run submit:ios
# equivalent to: eas submit --platform ios --profile production --latest
```

**From this sandbox, add `--no-wait`.** The upload outlives a single command
window, and if the CLI is killed mid-upload the submission dies with it —
nothing reaches Apple even though `eas build:list` still says `finished`. With
`--no-wait`, EAS performs the upload server-side; verify against Apple
afterwards instead of trusting the CLI's exit.

### App Store Connect API key

`eas submit` does **not** read `EXPO_ASC_API_KEY_PATH` / `EXPO_ASC_KEY_ID` /
`EXPO_ASC_ISSUER_ID` — those only feed `eas metadata`, so exporting them looks
right and still fails with "App Store Connect API Keys cannot be set up in
--non-interactive mode". Submission resolves the key from `eas.json` →
`submit.production.ios`, which needs **all three** of `ascApiKeyPath`,
`ascApiKeyIssuerId`, `ascApiKeyId`; any subset is rejected outright.

The key file is gitignored, so a fresh clone must rebuild it from the stored
secrets before submitting. Note the two are stored **swapped**:

- `EXPO_ASC_API_KEY_P8` actually holds the **Key ID**;
- `EXPO_ASC_KEY_ID` actually holds the **.p8 body**, with its newlines
  collapsed — re-wrap the base64 at 64 columns between
  `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` and write it to
  `credentials/asc-api-key.p8` (mode 600);
- `EXPO_ASC_ISSUER_ID` is correct as stored.

Verify with `openssl pkey -in credentials/asc-api-key.p8 -noout` before
submitting — a mangled PEM fails late, after the upload.

This uploads the binary and makes it available in **TestFlight**. It does
**not** submit the app for App Store review — that remains a deliberate manual
step in App Store Connect.

Confirm the build actually reached Apple (TestFlight → **1.0.2 (16)**, or the
ASC `/v1/builds` API) rather than assuming a scheduled submission arrived.

Submission targets (from `eas.json` → `submit.production.ios`):

| Field | Value |
| --- | --- |
| Bundle identifier | `com.secureopscommand.mobile` |
| Apple ID | `justin.knox@williamscouncil.com` |
| App Store Connect app id (`ascAppId`) | `6789409652` |
| EAS project id | `e8bcd802-b11d-4c4d-bd20-5e61caf4817c` |

## 4. Device smoke test — REQUIRED before release

> **Native compile gate:** Kotlin (`AudioRouteModule.kt`) and Swift
> (`AudioRouteModule.swift`) are compiled only at **EAS build** time — not by
> the dev sandbox. `tsc --noEmit` and the Vitest suite validate the JS/TS
> contract but cannot catch Kotlin/Swift type errors or missing symbols.
> Treat a successful EAS build (step §3 above) as the native-compile gate;
> do not skip it even if all JS checks pass.

Run the full checklist on **both** iOS (TestFlight) and Android (internal track
or sideload) before submitting to either store. Given the build-14 history, this
gate is not optional — the test suite cannot prove locked-screen survival or
Bluetooth routing on real hardware.

### 4a. iOS (TestFlight)

Install the TestFlight build on two real iOS devices, at least one with a paired
Bluetooth headset.

1. Both join a channel → presence shows both members.
2. Device A holds **Hold to talk** → A shows "transmitting", B hears audio and
   sees "A is transmitting…".
3. While A talks, B's PTT button is disabled ("Channel busy") — the
   single-speaker lock holds.
4. A releases → audio stops, lock frees, B can now transmit.
5. Background device A's app mid-transmission → audio keeps flowing.
6. **Locked-phone keep-alive:** device B joins a channel, locks the phone, and
   stays idle for **2+ minutes** (longer than the ~30s suspension window). Then
   device A transmits — B **must hear it** with the screen still locked. Repeat
   after B has been locked ~10 minutes for extra confidence.
7. **Interruption recovery:** with B locked and joined, call B's phone; end the
   call, unlock B briefly (foreground the app), re-lock, wait 2+ minutes, then
   A transmits — B must still hear it (the foreground pass restarts the
   keep-alive player that the call interrupted).
8. **Keep-alive stops with demand:** on B, mute or leave the active channel
   (or sign out) → the silent keep-alive stops with the last radio connection;
   lock B for 2+ minutes and confirm the app suspends normally. This matches
   the App Review disclosure in `APP_REVIEW_NOTES.md` §3.
9. **Audio quality:** A transmits a full sentence held at arm's length → B hears
   it as natural speech out of the **speakerphone**. Robotic, underwater or
   "bad speakerphone" audio means something has re-applied an AVAudioSession
   category/mode override — see the Bluetooth note below.
10. Point the app at a server **without** LiveKit env → app stays usable,
    presence works, PTT shows the "not configured" notice (503 path).

Only after 1–10 pass should the version be submitted for App Store review in
App Store Connect.

> **Bluetooth headset support ships in this build, engaged CONDITIONALLY.**
> The fatal flaw of the 2026-07-30 attempt was applying `voiceChat` mode +
> forced routing **unconditionally** — every listener heard robotic audio
> regardless of whether a headset was connected. This build instead monitors
> for native connect/disconnect events and applies options **only while an HFP
> device is the active route**, using `videoChat` mode (not `voiceChat`) to
> keep WebRTC's own AEC/AGC/NS in charge. With no headset present the session
> is byte-for-byte identical to the pre-feature build.
>
> **Architecture (2026-08-xx revision, updated):** both iOS and Android use the
> same event-driven path via the local `audio-route` native module — iOS from
> `AVAudioSession.routeChangeNotification` (Swift), Android from three
> complementary Kotlin signals (all funnel into one `onAudioRouteChange` event):
>
> 1. `AudioManager.AudioDeviceCallback` — device physical connect/disconnect.
> 2. `AudioManager.addOnCommunicationDeviceChangedListener` (API 31+) — fires
>    when the OS selects a different communication device without a physical
>    connect/disconnect event (the "selection gap" AudioDeviceCallback misses).
> 3. `BroadcastReceiver(ACTION_SCO_AUDIO_STATE_UPDATED)` (pre-31) — pre-31
>    equivalent: fires on every SCO channel state transition so `isBluetoothScoOn`
>    changes are always observed.
>
> **No background poll exists.** The 2-second `getAudioOutputs()` poll was removed
> after code review found it called `onBtStateChange(false)` on iOS every 2 s —
> reverting config the route listener had just applied.
>
> **BLUETOOTH_CONNECT is requested LAZILY** (Android 12+ / API 31+ only): the
> route listener is registered without the permission (detection APIs — device
> type integers, `isBluetoothScoOn` — do not require it). The OS permission
> dialog appears only the first time a BT headset is detected as the active
> communication device. A denial leaves the radio on the baseline config; no
> re-prompt loop is possible.
>
> **Hardware verification per §4a Q1–Q2 below is mandatory before release.**

**§4a BT smoke-test steps (run before App Store submission):**

10b. **BT headset — audio quality:** pair an HFP headset (AirPods, any Bluetooth
     headset with mic). Join a channel. Transmit with the headset mic — B must
     hear natural, non-robotic speech at the **speaker** output (not robotic,
     not underwater). This confirms `videoChat` mode + WebRTC AEC are in charge
     rather than Apple's `voiceChat` voice-processing.

10c. **BT headset — mic capture:** transmit using the headset mic; B must hear
     the voice clearly. Disconnect the headset mid-session — the app must
     **automatically fall back to the built-in mic** without crashing or
     producing audio artifacts.

10d. **No-headset parity:** with no BT device paired, confirm steps 1–10 above
     still produce identical audio quality to the previous build. The route-change
     event listener must not fire spuriously — if robotic audio appears with no
     headset, `AVAudioSession.routeChangeNotification` is firing for a non-HFP
     reason and `isBluetoothHFPActive()` is returning a false positive.

10e. **Android BT:** on Android, transmit with a paired BT headset → B hears
     the voice clearly. Disconnect the headset → fallback to speakerphone
     automatically (AudioSwitchManager reroutes on device removal). Confirm the
     BLUETOOTH_CONNECT permission prompt appears the first time a BT headset is
     paired and does NOT appear when no headset is used (Q1 hardware check).

> **Open hardware question remaining for the §4 smoke test:**
> - **Q1 (Android)** Does the BLUETOOTH_CONNECT runtime prompt appear at the
>   correct moment — the first time the headset becomes available in the device
>   list — and NOT at session start and NOT for officers without a headset?
>   The lazy path is: `onAudioRouteChange` event fires →
>   `hasBluetoothHeadsetAvailable` true → `requestBluetoothPermission()` called
>   once. If the prompt appears without a headset, `checkHasBluetoothHeadsetAvailable()`
>   has a false-positive — tighten the `getDevices()` type filter.
>
> **Q2 (iOS engine overwrite) — resolved in code:**
> `registerGlobals()` installs `setupIOSAudioManagement()` with a static
> default handler that applies `{ allowBluetooth + mixWithOthers + videoChat }`
> on every `willEnableEngineHandler` / `didDisableEngineHandler` event,
> overwriting whatever config our BT state machine had set. Fix: in
> `startBtRouteMonitor()`, immediately after `registerGlobals()` has run,
> call `setupIOSAudioManagement(true, iosEngineAudioConfig)` again — the
> `activeAudioManagementSetup` token (AudioManager.ts:41–43) makes the old
> cleanup a no-op and replaces both handlers with our BT-aware callback.
> The callback returns our BT config when `btActive=true` and LiveKit's
> exact default when `btActive=false` (byte-for-byte match to
> `getDefaultAppleAudioConfigurationForAudioState(preferSpeakerOutput=true)`,
> AudioManager.ts:122–146). Covered by the `radioMediaBluetooth.native.test.ts`
> engine-config handler suite.
> **Hardware check remaining:** audio quality only — confirm first post-connect
> transmission sounds natural (non-robotic) with a BT headset connected, as a
> final integration check of the handler on real hardware.

### 4b. Android (internal track / sideload)

Android has a different audio-focus model (AudioFocus, foreground service,
WAKELOCK) from iOS, so it must be tested separately. Two Android devices are
needed.

The baseline `configureAudio` passes only `AndroidAudioTypePresets.communication`
(no `preferredOutputList`, no `forceHandleAudioRouting`). BT headset routing is
applied via **`selectAudioOutput("bluetooth")`** on the running AudioSwitch
instance — NOT via `configureAudio`. See the source citation below.

**Android BT routing mechanism (cited source):**
`AudioSwitchManager.java:135` (bundled in `@livekit/react-native`) — the
`preferredDeviceList` is passed **only to the `AudioSwitch` constructor** inside
`start()`; there is no post-start setter, so calling `configureAudio({
preferredOutputList })` after `startAudioSession()` cannot affect the running
AudioSwitch. Contrast with `AudioSwitchManager.java:184–202`:
`selectAudioOutput()` calls `handler.post(() -> audioSwitch.selectDevice(device))`
on the live instance — this IS effective post-start.

**Android BT state machine:**
- BT headset appears in device list (`AudioDeviceCallback.onAudioDevicesAdded`)
  → `hasBluetoothHeadsetAvailable = true` (permission-free; type integer check).
- **First** availability event → lazy `BLUETOOTH_CONNECT` request (one prompt,
  never repeated). On grant: `selectAudioOutput("bluetooth")`.
- BT headset removed → `hasBluetoothHeadsetAvailable = false`
  → `selectAudioOutput("speaker")` explicitly restores the baseline.
- If permission was denied: disconnect events do NOT call `selectAudioOutput`
  (route was never changed from speaker; nothing to revert).

**Android permission timing:**
`BLUETOOTH_CONNECT` is declared in `app.json` and requested at runtime via
`AudioRouteModule.requestBluetoothPermission()` (Expo PermissionsManager, no
react-native import). The detection APIs that run WITHOUT the permission:
`AudioManager.getDevices()` (type integers), `getCommunicationDevice().type`
(integer field), `isBluetoothScoOn()` (boolean). The permission prompt appears
the first time a BT headset becomes AVAILABLE (physical device present) —
officers without a headset never see it.

1. **Basic PTT** — repeat §4a steps 1–5 on Android devices. Audio should route
   out of the **speakerphone** (not earpiece) when no headset is connected.
2. **Clocked in, phone locked** — device B clocks in so the radio screen is
   active. Lock the screen. Wait **2+ minutes**. Device A transmits — B must
   hear it (the WAKELOCK + AudioFocus hold open on Android; the expo-audio
   silent loop is the safety net). Repeat at 5 min and 10 min.
3. **Clock-out stops audio** — B clocks out (radio screen tears down). Lock the
   phone, wait 2 minutes, A transmits — B must **not** hear anything, confirming
   that demand is zero and the keep-alive is stopped.
4. **Interruption recovery** — with B locked and joined, receive a phone call,
   end it, briefly foreground the app, re-lock, wait 2 min, A transmits — B
   hears it (Android AudioFocus re-granted on foreground; keep-alive replayed).
5. **Audio quality** — A transmits a full sentence held at arm's length → B
   hears natural speech from the speakerphone. Robotic/underwater audio means
   a routing or audio-mode override has crept back in (see §4a).
6. **BT headset — connect and capture (Android 12+):**
   a. Fresh install, no BT device paired → join a channel → **no BLUETOOTH_CONNECT
      prompt** must appear (Q1 check: availability trigger is not firing without
      a headset).
   b. Pair a BT headset while joined → the BLUETOOTH_CONNECT prompt appears
      **exactly once** (Q1 check: prompt fires at the first availability event,
      not at session start).
   c. Grant the permission → audio routes to the BT headset mic. Transmit —
      partner B hears natural speech through their speaker (not robotic/underwater).
   d. Disconnect the headset mid-session → audio falls back to the speakerphone
      **immediately and automatically** (Q2 check: `selectAudioOutput("speaker")`
      was called on disconnect; no crash or silence).
7. **BT headset — connect and capture (Android < 12):**
   Repeat step 6b–6d on a pre-API-31 device. No permission prompt appears (not
   required pre-31). Verify SCO audio routes to headset on connect and reverts
   on disconnect.
   **Pre-31 SCO receiver (deferred-context check):** On pre-31 the third listener
   signal is a `BroadcastReceiver(ACTION_SCO_AUDIO_STATE_UPDATED)` registered in
   `registerRouteListeners(am, rc)`.  `rc` (reactContext) is resolved from the
   same snapshot as `audioManager` in `ensureRouteListenersRegistered()` — the
   TOCTOU race where reactContext becomes null between the audioManager check and
   the receiver registration is closed.  If context is null the whole registration
   defers to the next call site.  To exercise the deferred-context path: connect
   the headset **before** opening the app, then open the app and join a channel.
   The `OnStartObserving("onAudioRouteChange")` fallback must install the SCO
   receiver, and headset connect/disconnect must be observed normally.  If audio
   stays on the earpiece and never routes to the headset, the SCO receiver was not
   registered — escalate to the deferred-context step (step 9 below).
8. **No BT prompt without headset (any API level)** — install fresh with no
   BT device ever paired → join, transmit, receive for 5+ minutes → zero
   BLUETOOTH_CONNECT prompts ever shown.
9. **Deferred-context registration** — this scenario tests the Android lazy
   listener path: the OS can instantiate the `AudioRoute` Expo module before
   `reactContext` is fully live (so `audioManager` is null at `OnCreate`), which
   means route-change listeners are deferred to the first JS entry point.
   To exercise this:
   a. **Connect headset AFTER the radio session has started** — open the officer
      app, join a channel, confirm the radio is streaming normally, **then** pair
      and connect a BT headset.  The BLUETOOTH_CONNECT prompt must appear (first
      availability event), grant it, and audio must route to the headset within a
      few seconds. If the prompt never appears and audio stays on speaker, the
      `ensureRouteListenersRegistered()` lazy path did not fire — check
      `OnStartObserving("onAudioRouteChange")` registration (cited:
      `ObjectDefinitionBuilder.kt:496`, expo-modules-core@3.0.30).
   b. **Repeat at cold start**: force-stop the app, connect the headset, then
      open the app and join a channel. This tests the eager `OnCreate` path where
      `reactContext` should already be live. Prompt + routing must both work.

### App Review notes to include

See `APP_REVIEW_NOTES.md` — §3 covers the background-audio justification and
must stay in sync with the keep-alive's actual scope.

- **Microphone**: used for live push-to-talk radio between officers and dispatch
  while on shift (`NSMicrophoneUsageDescription`).
- **Background audio** (`UIBackgroundModes: audio`): officers must keep hearing
  the channel when the phone is locked or another app is foregrounded during a
  shift.
- **Encryption** (`ITSAppUsesNonExemptEncryption: false`): audio uses standard
  end-to-end encryption via the platform/WebRTC; no proprietary cryptography.
- Demo account for review: the `guest@secureops.com` "Try Demo" login (password
  per the deployment's `DEMO_GUEST_*`).

## 5. After Apple's final release

Verify on a released-build device: update to `1.0.2`, grant the mic prompt, and
re-run the smoke test above against the production API. Then confirm OTA
targeting: `eas update:list --branch production` runtime should read `1.0.2`
and match `eas build:list`.

---

### Android Bluetooth permission (API 31+)

`BLUETOOTH` and `BLUETOOTH_CONNECT` are declared in `app.json`:

- `android.permission.BLUETOOTH` — retained for AudioSwitchManager internals
  on older API levels.
- `android.permission.BLUETOOTH_CONNECT` — required on API 31+ for SCO mic
  capture. Requested **lazily** via `AudioRouteModule.kt` / Expo's
  PermissionsManager at the first moment `hasBluetoothHeadsetAvailable`
  transitions false→true (BT device physically appears in the device list).

**What does NOT require the permission** (all run before the prompt):
- `AudioManager.getDevices(GET_DEVICES_ALL)` — type integers; no permission.
- `AudioManager.getCommunicationDevice().type` — integer field; no permission.
- `AudioManager.isBluetoothScoOn()` — boolean; no permission.
- `AudioDeviceCallback` registration and event receipt — no permission.

**Permission lifecycle:**
1. Session starts (no headset) → listener registered, zero permission calls.
2. BT headset appears in device list → `hasBluetoothHeadsetAvailable = true`
   → `requestBluetoothPermission()` called exactly once.
3. Granted → `selectAudioOutput("bluetooth")` on running AudioSwitch.
4. Denied → radio stays on baseline speaker; no re-prompt loop.
5. Headset disconnects (granted path) → `selectAudioOutput("speaker")`.
6. Headset disconnects (denied path) → no-op (route was never changed).

**If hardware testing (§4b step 6a) shows the prompt without a headset:**
The trigger `checkHasBluetoothHeadsetAvailable()` in `AudioRouteModule.kt`
is scanning `getDevices()` and finding a BT device that is not an HFP headset
(e.g. a car kit, A2DP speaker). Tighten the filter: also check
`device.type == TYPE_BLUETOOTH_A2DP` is excluded, or restrict to
`isSource()` devices only (headset mics are source devices).
