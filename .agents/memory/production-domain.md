---
name: Production custom domain
description: Which domain is the real production URL for THIS deployment and what drives links/CORS
---

**This project is the WCSG customer deployment. Its live production URL is https://wcsgisecureops.com.** APP_BASE_URL and ALLOWED_ORIGINS must equal it (user-confirmed 2026-07-18 during the master-build sync).

**https://secureopscommand.com** (alias `SecureOps-Command.replit.app`) is a SEPARATE SecureOps project — it hosts the org directory (`ORG_DIRECTORY` env) that resolves mobile org codes to customer backends. The org code for this backend is `wcsgi` (`ORG_CODE` env). Changing the directory mapping requires editing/republishing THAT project, not this one.

**Role swap (user-declared 2026-07-25): THIS project is now the MASTER for the SecureOps Command app** — it is the canonical publisher of OTA updates to the phone app (runtime 1.0.0, branch production). The secureopscommand.com project is demoted to a demo; the user is removing its `EXPO_TOKEN` (and any Apple/ASC submission secrets) so its deploys can no longer publish OTAs or touch the App Store. Until that removal is confirmed, a deploy of the demo project could still clobber this project's OTA bundle. The demo project still hosts the org directory, so it must stay deployed (or the directory must move) — removing EXPO_TOKEN does not affect the directory.

**Why:** this codebase is synced wholesale from the master repo (justinknox-SecureOpsDev/SecureOpsCommand); memory files imported with it may describe the master project's domains — for this project, always treat wcsgisecureops.com as production.

**APP_BASE_URL (production) must equal the current primary domain** — it builds every link inside reset / onboarding / amendment / invite emails. Changing production env vars requires a republish to take effect.

**Dev preview privacy** is a platform toggle, NOT code: Developer tools → Networking → "Private development URL".
