# Native Release Runbook — Live Push-to-Talk Radio

This runbook covers shipping the **live PTT voice radio** feature to the mobile
app. Unlike the multi-org change (see `OTA_RELEASE_RUNBOOK.md`), this feature
**cannot** ship over-the-air.

## ⛔ Why this is a NEW native build, not an OTA update

Live radio adds **new native modules** to the binary:

- `@livekit/react-native` + `@livekit/react-native-webrtc` (the WebRTC media stack)
- iOS `UIBackgroundModes: ["audio"]` + `NSMicrophoneUsageDescription`
- Android `FOREGROUND_SERVICE_MICROPHONE` + the LiveKit/WebRTC config plugins

`expo-updates` (OTA) can only swap the **JavaScript bundle** — it cannot add
native code or new OS permissions. The installed `1.0.2` binary has no WebRTC
framework and no microphone/background-audio entitlements, so an OTA bundle that
calls into LiveKit would crash at runtime on those installs.

**Therefore: bump the version, build a fresh binary, and submit to the App
Store.** The runtime-version policy is `appVersion`, so bumping `expo.version`
to `1.0.3` gives the new binary runtime `1.0.3` — which correctly isolates it
from the `1.0.2` OTA channel (so a radio JS bundle can never reach a WebRTC-less
`1.0.2` install).

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

## 1. Bump the version

In `app.json`, change `expo.version` `1.0.2` → `1.0.3`. Leave
`runtimeVersion.policy` as `appVersion`. The iOS `buildNumber` / Android
`versionCode` are managed by EAS (`eas.json` → `appVersionSource: "remote"` +
`production.autoIncrement: true`), so you do not edit those by hand.

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
6. Point the app at a server **without** LiveKit env → app stays usable,
   presence works, PTT shows the "not configured" notice (503 path).

## 3. Production build

```bash
cd artifacts/security-ops
eas build --profile production --platform ios
# (and, when releasing Android) eas build --profile production --platform android
```

The `production` profile is on the `production` channel, so once this binary is
released, future **JS-only** radio fixes can ship OTA to it (same
`OTA_RELEASE_RUNBOOK.md` flow, but against runtime `1.0.3`).

## 4. Submit to the App Store

```bash
cd artifacts/security-ops
pnpm run submit:ios
# equivalent to: eas submit --platform ios --profile production --latest
```

Submission targets (from `eas.json` → `submit.production.ios`):

| Field | Value |
| --- | --- |
| Bundle identifier | `com.secureopsmobilecommand.app` |
| Apple ID | `justin.knox@williamscouncil.com` |
| App Store Connect app id (`ascAppId`) | `6773903231` |
| EAS project id | `452c8467-1a26-4e16-9b41-e5799d80023e` |

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

Verify on a released-build device: install/update to `1.0.3`, grant the mic
prompt, and run the two-device smoke test from step 2 against the production API.

---

### Scope reminder

This task **documents** the procedure and verifies the code (typecheck + tests).
It does **not** run `eas build`/`eas submit` or bump the shipped version — those
are manual steps run by the release owner with their Expo/Apple credentials.
