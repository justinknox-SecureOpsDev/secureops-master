---
name: Android Auto Backup restores org + session
description: Why a "brand new" Android phone can skip first-run gates (connect/org code, login) — and how to prove what a store build actually contains.
---

# Android Auto Backup restores org + session

Expo's `android.allowBackup` defaults to **true**. Android then backs the app's
AsyncStorage up to the user's Google account and **restores it during new-phone
setup**, so a device that has "never had the app" can start with the selected
organization and a valid auth token already present.

Symptom seen in the field: a fresh Android install opened straight on the
sign-in screen instead of the "Connect your organization" code screen. The
startup gate only forces `/connect` when no org is stored, so restored data
makes it look like the gate is broken. iOS does not do this on a plain
reinstall, so it reads as an Android-only bug.

**Why it matters beyond the routing symptom:** the backed-up blob contains the
session token. A token silently restored onto a different physical device is a
security problem, independent of any first-run UX.

**How to apply:** set `android.allowBackup: false` in `app.json` for any app
that stores auth tokens or tenant/org selection in AsyncStorage. It is native
config — it ships only in a NEW binary, never over the air. Existing devices
keep their restored data; the escape hatches are the login screen's
"Connected to … · Switch" row and Settings → Apps → Storage → Clear storage.

## Proving what a store build actually contains

Before chasing a "the store build is missing feature X" report, unpack the real
artifact instead of trusting the source tree:

```
eas build:list --platform android --limit 6 --non-interactive --json   # get applicationArchiveUrl
curl -sSL -o build.aab "<applicationArchiveUrl>"
unzip -p build.aab base/assets/index.android.bundle > build.bundle
grep -c "SOME UI STRING" build.bundle
unzip -p build.aab base/assets/app.config   # version, runtimeVersion policy, updates URL
```

Grepping a distinctive on-screen string against each shipped versionCode
settles "is the feature in the build the tester has?" in minutes. The OTA
counterpart does NOT work the same way: the manifest at `u.expo.dev/<projectId>`
is fetchable with `expo-platform` / `expo-runtime-version` headers, but the
`assets.eascdn.net` launch-asset URL returns 403 "Unauthorized asset request",
so use the `.aab` route.
