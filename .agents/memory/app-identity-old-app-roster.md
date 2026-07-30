---
name: Old-app detection & install notice
description: How "is this officer on the current app" is decided and how the install-the-new-app notice is delivered
---

**Rule:** "On the current app" = the install self-reported the CURRENT Expo project UUID (env-overridable CURRENT_EXPO_PROJECT_ID). Never compare version strings — the legacy app is a different Expo project/bundle ID and can never self-report, so never-reported ⇒ out of date by definition.

**Why:** The bundle ID changed at the rebrand, so legacy users must INSTALL the new store listing (Update does nothing). Version equality would misclassify future current-app builds; project identity can't.

**How to apply:**
- Self-reports arrive via POST /auth/app-identity (fires on every authenticated launch even when push permission is denied) and piggy-backed on /auth/push-token.
- PUSH_TOO_MANY_EXPERIENCE_IDS batch splits back-fill `appProjectId` with an Expo *experience id* (`@acct/slug`) for rows that never self-reported — that label intentionally never equals the UUID, keeping them "old app". Self-reports always win (guarded by appReportedAt IS NULL).
- The admin notice (POST /admin/app-update-notice) reaches legacy installs via push (per-project split), the persisted in-app notification row, and optional SMS; it stamps appUpdateNotifiedAt so repeat sends are deliberate.
- Store links: iOS id from ascAppId in security-ops eas.json; Android from app.json android.package. Defaults live in api-server lib/mobileApp.ts.
