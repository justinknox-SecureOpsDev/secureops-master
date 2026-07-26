---
name: Google Play photo/video permission policy (system photo picker)
description: Why Play rejects READ_MEDIA_IMAGES/VIDEO and how the SecureOps mobile app satisfies it with the OS photo picker.
---

# Google Play photo/video permission policy

Google Play rejects apps targeting Android 13+ (API 33+) that declare
`READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` when the OS **system photo picker** is
technically sufficient. For SecureOps the only media use is attaching a single
existing image (license/passport/cert photos, incident attachments, application
uploads) — the picker is sufficient, so those broad permissions are disallowed.

## How the app complies
- `expo-image-picker`'s `launchImageLibraryAsync({ allowsEditing: false })`
  ALREADY uses the Android Photo Picker (`ACTION_PICK_IMAGES`, backported to
  pre-33 via the Play-services `photopicker` service in the module's manifest).
  It runs out-of-process and needs **NO** runtime permission.
- So do NOT call `ImagePicker.requestMediaLibraryPermissionsAsync()` for the
  library path — requesting that permission is exactly what Play flags. (Still
  request `requestCameraPermissionsAsync()` for the camera path.)

## Where the permission actually came from
Non-obvious: in Expo SDK 54, `expo-image-picker`'s native
`android/src/main/AndroidManifest.xml` declares only CAMERA +
READ/WRITE_EXTERNAL_STORAGE — it does NOT add READ_MEDIA_IMAGES/VIDEO. So the
offending `READ_MEDIA_IMAGES` came solely from the explicit entry in `app.json`
`android.permissions`. Removing that line is the primary fix.

## The robust fix (managed Expo, no committed android/ dir)
1. Remove `READ_MEDIA_IMAGES` from `app.json` `android.permissions`.
2. Add BOTH to `app.json` `android.blockedPermissions` — a real Expo field
   (`@expo/config-types`; consumed by `@expo/config-plugins` android/Permissions)
   that injects `<uses-permission … tools:node="remove"/>` so the *merged*
   AndroidManifest strips them even if a transitive lib re-adds them.

**Why belt-and-suspenders:** Play's scanner reads the FINAL merged manifest; a
future dependency bump could reintroduce the permission via manifest merge.
`blockedPermissions` guarantees it stays out. Blocking a permission nothing
requests is a harmless no-op; blocking one the picker "uses" is safe because the
picker is permissionless.

**How to apply / edge case:** if a future feature genuinely needs full-library
access (e.g. `expo-media-library` gallery browsing), you must remove the block
AND justify the permission to Play — don't just delete the block silently.

## Version code on resubmit
`eas.json` uses `appVersionSource:"remote"` + production `autoIncrement:true`, so
the stale `versionCode` in app.json is ignored and EAS auto-picks the next code
above the last submitted build. No manual bump needed to clear the rejected v4.
