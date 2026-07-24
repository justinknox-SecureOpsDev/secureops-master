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
native code or new OS permissions. Older `1.0.0` binaries (builds ≤ 9) have
none of these native modules; build 10 (the live store build as of July 2026)
has the LiveKit natives but **not** `expo-audio`. That is why
`radioMedia.native.ts` loads `expo-audio` through the guarded lazy
`getExpoAudio()` require — a `1.0.0` OTA bundle must run on build 10.

**Therefore: build a fresh binary and submit to the App Store, bumping the
version in the same change (see §1).** The runtime-version policy is
`appVersion`, so bumping `expo.version` to `1.0.1` at build time gives the new
binary runtime `1.0.1`, isolating it from the `1.0.0` OTA channel. Do NOT bump
the version ahead of the build — see the warning in §1.

### Locked-phone survival (why the silent keep-alive exists)

`UIBackgroundModes: audio` only prevents iOS suspension while the audio unit is
**actually rendering**. On a quiet PTT channel there are zero remote tracks
(each transmission is a short-lived publisher room), so iOS suspends the app
~30 seconds after the screen locks and the officer silently misses every later
transmission. `radioMedia.native.ts` therefore loops a silent wav
(`assets/audio/silence.wav`) via `expo-audio` for exactly as long as the radio
session is up (user has joined a channel), and `RadioScreen.tsx` re-reconciles
the listen room + control WebSocket on return to foreground.

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

## 1. Bump the version — ONLY when you actually cut the new binary

In `app.json`, change `expo.version` `1.0.0` → `1.0.1` **as part of building the
new binary, not before**. Leave `runtimeVersion.policy` as `appVersion`. The iOS
`buildNumber` / Android `versionCode` are managed by EAS (`eas.json` →
`appVersionSource: "remote"` + `production.autoIncrement: true`), so you do not
edit those by hand.

> ⚠️ **July 2026 lesson:** the repo sat at `1.0.1` for days while every live
> store build was runtime `1.0.0` — so every auto-OTA-on-deploy published to a
> runtime nobody had, and NO installed device received updates. The version has
> been returned to `1.0.0` until the new binary actually ships. Additionally,
> `radioMedia.native.ts` now loads `expo-audio` through a guarded lazy require
> (`getExpoAudio()`), so a `1.0.0`-runtime OTA bundle is safe on binaries built
> before expo-audio existed — the silent keep-alive is simply disabled there.
> Locked-phone survival (steps 6–8 below) still requires the new binary.
>
> The **LiveKit natives get the same guard**: builds ≤ 9 of runtime `1.0.0`
> have no `@livekit/react-native` / `@livekit/react-native-webrtc` at all, and
> an earlier OTA that imported them at module top level crashed those installs
> the moment Radio/Chat opened. `radioMedia.native.ts` (`getLiveKitNative()`)
> and `radioKeyProvider.ts` (`createRadioKeyProvider()`) now require them
> lazily; when absent, the radio degrades to presence-only with an "update the
> app from the App Store" notice. Any NEW native dependency the radio JS
> touches must get the same guard before it ships in a `1.0.0` OTA.

### Binary-gated native packages (enforced by a test)

The list of native packages that are missing from some served binaries lives
in `components/radio/nativeModules.ts` → `BINARY_GATED_NATIVE_PACKAGES`,
together with the only files allowed to `require()` each of them:

| Package | Present in | Guarded loader |
| --- | --- | --- |
| `@livekit/react-native` | build ≥ 10 only | `components/radio/nativeModules.ts` (`getLiveKitNative()`) |
| `@livekit/react-native-webrtc` | build ≥ 10 only | `components/radio/nativeModules.ts` (`getLiveKitWebRTC()`) |
| `expo-audio` | NO current store build | `components/radio/radioMedia.native.ts` (`getExpoAudio()`) |

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

## 2. Build + test a dev client (recommended before the store build)

Radio's native modules mean **Expo Go will not work** — you need a development
build. Build one and smoke-test on a real device:

```bash
cd artifacts/security-ops

# iOS dev client (internal distribution / simulator-capable)
eas build --profile development --platform ios

# Android dev client (APK)
eas build --profile development --platform android
```

Install the resulting build on a device, then run the dev server and connect:

```bash
pnpm exec expo start --dev-client
```

Smoke test (two devices on the same channel):
1. Both join a channel → presence shows both members.
2. Device A holds **Hold to talk** → A shows "transmitting", B hears audio and
   sees "A is transmitting…".
3. While A talks, B's PTT button is disabled ("Channel busy") — the
   single-speaker lock holds.
4. A releases → audio stops, lock frees, B can now transmit.
5. Background device A's app mid-transmission → audio keeps flowing (background
   audio entitlement).
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
   lock B for 2+ minutes and confirm the app suspends normally (no
   audio-session indicator, transmissions from A are NOT heard until B
   rejoins). This matches the App Review disclosure in `APP_REVIEW_NOTES.md` §3.
9. Point the app at a server **without** LiveKit env → app stays usable,
   presence works, PTT shows the "not configured" notice (503 path).

## 3. Production build

```bash
cd artifacts/security-ops
eas build --profile production --platform ios
# (and, when releasing Android) eas build --profile production --platform android
```

The `production` profile is on the `production` channel, so once this binary is
released, future **JS-only** radio fixes can ship OTA to it (same
`OTA_RELEASE_RUNBOOK.md` flow, but against runtime `1.0.1`).

## 4. Submit to the App Store

```bash
cd artifacts/security-ops
pnpm run submit:ios
# equivalent to: eas submit --platform ios --profile production --latest
```

Submission targets (from `eas.json` → `submit.production.ios`):

| Field | Value |
| --- | --- |
| Bundle identifier | `com.secureopscommand.mobile` |
| Apple ID | `justin.knox@williamscouncil.com` |
| App Store Connect app id (`ascAppId`) | `6789409652` |
| EAS project id | `e8bcd802-b11d-4c4d-bd20-5e61caf4817c` |

### App Review notes to include

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

Verify on a released-build device: install/update to `1.0.1`, grant the mic
prompt, and run the two-device smoke test from step 2 (including the
locked-phone keep-alive step) against the production API.

---

### Scope reminder

This task **documents** the procedure and verifies the code (typecheck + tests).
It does **not** run `eas build`/`eas submit` or bump the shipped version — those
are manual steps run by the release owner with their Expo/Apple credentials.
