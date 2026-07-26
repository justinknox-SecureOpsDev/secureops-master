---
name: Mobile location is foreground-only
description: SecureOps mobile declares background-location + FGS-location but the code only ever does foreground one-shot reads; no geofencing. Load before any store permission declaration or location-perm edit.
---

The `security-ops` app **declares** `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, `isAndroidBackgroundLocationEnabled: true`, and iOS `NSLocationAlwaysAndWhenInUse` + `UIBackgroundModes: [audio]`.

**But the code only ever calls `requestForegroundPermissionsAsync()` + `getCurrentPositionAsync()`** at discrete user-initiated moments (clock in/out, patrol checkpoint, emergency), plus a 60s `setInterval` that pushes position to dispatch **only while the app is foregrounded** (or while the radio's background-audio session happens to keep it alive). There is **NO** `startLocationUpdatesAsync`, **NO** `TaskManager`/`defineTask` background task, **NO** `requestBackgroundPermissionsAsync`, and **NO geofencing** (`startGeofencingAsync`/region monitoring) anywhere.

**Why it matters (Play Console / App Store):**
- FGS-location task = "User-initiated location sharing" (officer clocks in → live position to dispatch). NOT Geofencing, NOT Navigation.
- Never check Geofencing — there is none; the store then demands a geofencing demo video that can't be produced honestly.
- The declared background-location permission is effectively dormant (never requested at runtime), so it is a standing rejection risk. Dropping `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` + `isAndroidBackgroundLocationEnabled` would simplify approval but needs a NEW binary/AAB.
- `FOREGROUND_SERVICE_MEDIA_PLAYBACK` is NOT in app.json — `expo-audio` (radio keep-alive) auto-merges it; task = "Media playback" (incoming radio audio in background).
- `FOREGROUND_SERVICE_MICROPHONE` = push-to-talk two-way radio; Play Console task = "Background audio input".

**How to apply:** before answering any store permission form or editing location perms, re-grep for `requestBackgroundPermissionsAsync` / `startLocationUpdatesAsync` / `Geofenc`. If still absent, the app is foreground-only regardless of what the manifest declares.
