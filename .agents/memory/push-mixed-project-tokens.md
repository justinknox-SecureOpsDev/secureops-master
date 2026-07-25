---
name: Expo push tokens from mixed projects kill whole batches
description: Why a tenant deployment can silently lose ALL push notifications — legacy-app tokens mixed with current-app tokens in one Expo send.
---

Expo push tokens are minted per Expo PROJECT. Because tenants migrated from the retired legacy app (@justin.knox/secureops) to the current one (@justin.knox/secureops-command), a tenant DB's `users.expo_push_token` column can hold tokens from BOTH projects at once. Expo's push API rejects any request mixing projects (`PUSH_TOO_MANY_EXPERIENCE_IDS`, HTTP 400) — the WHOLE chunk fails, so **every** recipient loses the notification, which presents as "this org never sends notifications" while other orgs work.

**Why:** wcsgi prod lost all pushes this way July 2026; rgp kept working only because its DB had single-project tokens.

**How to apply:** the server-side cure lives in api-server push dispatch — on that error code, split the chunk by the project→tokens map in `err.details` and resend per project; DeviceNotRegistered tickets null the stored token so rows self-heal. If a tenant reports "no notifications from org X", check that tenant's deployment logs for PUSH_TOO_MANY_EXPERIENCE_IDS first, and remember the fix only reaches a tenant after ITS backend is republished.
