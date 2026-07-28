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

| iOS store build | `expo.version` / runtime | LiveKit natives | `expo-audio` |
| --- | --- | --- | --- |
| 1 – 9 | `1.0.0` | ❌ | ❌ |
| 10 | `1.0.0` | ✅ | ❌ |
| 14 | `1.0.1` | ✅ | ✅ |
| 15+ (this release) | `1.0.2` | ✅ | ✅ |

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

## 4. Device smoke test on TestFlight — REQUIRED before release

Install the TestFlight build on two real devices, at least one with a paired
Bluetooth headset. Given the build-14 history above, this gate is not optional.

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
9. **Bluetooth playback:** with a headset paired to B, A transmits → audio comes
   out of the **headset**, not the phone speaker.
10. **Bluetooth microphone:** B holds PTT while wearing the headset and speaks
    with the phone held away from their mouth → A hears them clearly (capture is
    on the headset mic, not the built-in one).
11. **Bluetooth fallback:** disconnect the headset mid-session → audio moves to
    speakerphone and PTT still captures on the built-in mic.
12. Point the app at a server **without** LiveKit env → app stays usable,
    presence works, PTT shows the "not configured" notice (503 path).

Only after 1–12 pass should the version be submitted for App Store review in
App Store Connect.

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

### Known gap — Android Bluetooth on API 31+

The Android manifest declares legacy `android.permission.BLUETOOTH` but not
`BLUETOOTH_CONNECT`, which Android 12+ requires to enumerate and route to a
paired headset. iOS is unaffected. If/when an Android release ships the
Bluetooth radio capability, that permission (and its runtime request) needs to
be added and tested separately.
