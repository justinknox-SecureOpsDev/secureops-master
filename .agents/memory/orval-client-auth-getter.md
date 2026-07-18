---
name: Generated API client auth getter
description: Every app bundle consuming @workspace/api-client-react must register setAuthTokenGetter, or all Orval-hook requests 401
---

The generated Orval client (`custom-fetch.ts`) attaches `Authorization` ONLY via a module-level `_authTokenGetter` registered with `setAuthTokenGetter()`. Module state is per-bundle: the Expo app registers its own getter in `_layout.tsx`; each web app must register its own at entry-module scope (before render).

**Why:** The admin portal shipped Dashboard/adminTasks/analytics/ProtectionDetail on generated hooks with no getter registered — every one of those requests went out with no Authorization header and 401'd ("Dashboard is not loading"), while legacy `api()`/`fetchWithAuth` calls (which read localStorage directly per call) kept working in the same session. The split symptom — only Orval-hook endpoints 401, everything else fine — is the fingerprint of a missing getter, not a server auth bug.

**How to apply:** When a new artifact (or a first Orval-hook usage in an existing artifact) consumes `@workspace/api-client-react`, register `setAuthTokenGetter` in its entry module and wire the lib's `setUnauthorizedHandler` to the app's logout. Diagnosis shortcut: `GET /api/version` is a public build-identity probe (`{version: <git sha>, builtAt}`) — use it to tell stale-prod-build problems apart from code bugs before debugging.
