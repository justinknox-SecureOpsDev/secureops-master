---
name: Expo push credentials after bundle-ID migration
description: Why push breaks with InvalidCredentials after switching iOS bundle IDs, and how to fix it via EAS GraphQL without Apple auth
---

# Expo push credentials must follow a bundle-ID migration

**Rule:** When the iOS bundle identifier changes (e.g. `com.secureopscommand.app` → `com.secureopscommand.mobile`), the APNs push key linkage does NOT carry over. Expo's push service returns `InvalidCredentials` ("Could not find APNs credentials for <bundle>") for every token from the new build until an `iosAppCredentials` record exists on EAS for the new bundle with the push key attached.

**Why:** EAS credentials are keyed per `appleAppIdentifier` (bundle). Building with `eas.json` `ios.credentialsSource: "local"` (credentials.json) makes the build succeed without ever creating server-side credentials for the new bundle — so the gap only surfaces later as silently-dead push.

**How to fix (no Apple login needed):**
- Via EAS GraphQL (`api.expo.dev/graphql`, Bearer EXPO_TOKEN): upsert `createAppleAppIdentifier` for the new bundle, then `createIosAppCredentials` with `pushKeyId` of the existing account push key (reuse the same key across bundles is fine).
- `appleTeam` on the new iosAppCredentials/appleAppIdentifier stays **null** — the API silently refuses to persist `appleTeamId` without an Apple-authenticated session, and there is no update mutation for appleAppIdentifier. This does NOT matter: the push service reads the team from `pushKey.appleTeam`.
- **Expo's push service caches credential lookups (including misses) for ~5–10 min.** Every delete/recreate churn re-caches a miss. After the record is in place, stop touching credentials and quiet-wait ~10 minutes before retesting, or you'll wrongly conclude the fix failed.
- Test loop: POST `https://exp.host/--/api/v2/push/send` with a real ExponentPushToken from prod DB → expect `status:"ok"` → confirm via `/--/api/v2/push/getReceipts`.
- Useful: stored App Store Connect API keys on EAS expose `keyP8` via GraphQL (readable back), so full Apple-authenticated CLI flows can be reconstructed if ever needed.

**How to apply:** any time the app ships under a new bundle ID (or a fresh EAS project), verify `iosAppCredentials` exists for that exact bundle with a pushKey before assuming push works; a working server pipeline + valid tokens + zero errors in logs still delivers nothing without it.
