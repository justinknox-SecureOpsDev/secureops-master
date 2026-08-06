---
name: Mobile location is foreground-only
description: SecureOps mobile only ever does foreground one-shot location reads — no background permission, no FGS-location, no geofencing. Load before any store permission declaration, review note, or location-perm edit.
---

The `security-ops` app is **foreground-location only**, in the manifest *and* in
the code.

- Android declares `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` only.
  `ACCESS_BACKGROUND_LOCATION` and `FOREGROUND_SERVICE_LOCATION` were removed and
  the expo-location plugin has `isAndroidBackgroundLocationEnabled: false` /
  `isAndroidForegroundServiceEnabled: false`.
- iOS declares `NSLocationWhenInUseUsageDescription` only — no "Always" string.
  (`UIBackgroundModes: [audio]` is the radio, not location.)
- The code calls `requestForegroundPermissionsAsync()` + one-shot
  `getCurrentPositionAsync()` at discrete moments (clock screen open, clock
  in/out, patrol checkpoint, emergency), plus a 60s ping while clocked in that
  **checks `AppState` and skips unless the app is foregrounded** — the radio's
  background-audio session can otherwise keep the screen mounted and turn the
  timer into background collection.
- There is **NO** `startLocationUpdatesAsync`, **NO** `TaskManager`/`defineTask`,
  **NO** `requestBackgroundPermissionsAsync`, and **NO geofencing**.

**Why it matters (Play Console / App Store):** every store answer must match the
list above. Never tick Geofencing or background location — the store then demands
a demo video that cannot be produced honestly, and a disclosure claiming more
collection than the app performs is itself a policy violation.

Other background-service tasks that DO exist: `FOREGROUND_SERVICE_MICROPHONE` =
push-to-talk ("Background audio input"), and `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
auto-merged by expo-audio for incoming radio audio ("Media playback").

**How to apply:** before answering any store permission form or editing location
perms, re-grep for `requestBackgroundPermissionsAsync` / `startLocationUpdatesAsync`
/ `Geofenc`, and re-read `artifacts/security-ops/APP_REVIEW_NOTES.md` §4 — the
notes have drifted from the code before.
