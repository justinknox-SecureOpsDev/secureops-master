---
name: Production custom domain
description: Which domain is the real production URL for THIS deployment and what drives links/CORS
---

**This project is the WCSG customer deployment. Its live production URL is https://wcsgisecureops.com.** APP_BASE_URL and ALLOWED_ORIGINS must equal it (user-confirmed 2026-07-18 during the master-build sync).

**https://secureopscommand.com** (alias `SecureOps-Command.replit.app`) is a SEPARATE SecureOps project — it hosts the org directory (`ORG_DIRECTORY` env) that resolves mobile org codes to customer backends. The org code for this backend is `wcsgi` (`ORG_CODE` env). Changing the directory mapping requires editing/republishing THAT project, not this one.

**The live Fleet Control Plane dashboard the operator actually uses (with real customers rgp/demo/wcsgi already registered) also lives on that SEPARATE secureopscommand.com project, not this repo's own `artifacts/control-plane` copy.** This repo has its own control-plane code/workflow/dev-DB (used for local dev/testing), but it is a disconnected duplicate — registering a customer here (via SQL or this repo's dev UI) does NOT make it appear on the dashboard the operator bookmarks and screenshots. To register/edit a real customer in the fleet the operator manages day to day, it must be done in that other project (its own UI "Add customer" button, or by an agent working inside that project) — this repo's `executeSql`/dev workflow cannot reach it.

**Role swap (user-declared 2026-07-25): THIS project is now the MASTER for the SecureOps Command app** — it is the canonical publisher of OTA updates to the phone app (runtime 1.0.0, branch production) and the sole holder of EXPO_TOKEN / App Store credentials. The secureopscommand.com project is demoted to a demo; the user confirmed (2026-07-25) its `EXPO_TOKEN` was removed, so its deploys can no longer publish OTAs — the old "master project could clobber our OTA bundle" risk is CLOSED. The demo project still hosts the org directory, so it must stay deployed (or the directory must move here first if it is ever retired).

**Why:** this codebase is synced wholesale from the master repo (justinknox-SecureOpsDev/SecureOpsCommand); memory files imported with it may describe the master project's domains — for this project, always treat wcsgisecureops.com as production.

**APP_BASE_URL (production) must equal the current primary domain** — it builds every link inside reset / onboarding / amendment / invite emails. Changing production env vars requires a republish to take effect.

**Dev preview privacy** is a platform toggle, NOT code: Developer tools → Networking → "Private development URL".
