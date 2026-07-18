---
name: Production custom domain
description: Which domain is the real production URL for THIS deployment and what drives links/CORS
---

**This project is the WCSG customer deployment. Its live production URL is https://wcsgisecureops.com.** APP_BASE_URL and ALLOWED_ORIGINS must equal it (user-confirmed 2026-07-18 during the master-build sync).

**https://secureopscommand.com** (alias `SecureOps-Command.replit.app`) is the SEPARATE master SecureOps project — it hosts the org directory (`ORG_DIRECTORY` env) that resolves mobile org codes to customer backends. The org code for this backend is `wcsgi` (`ORG_CODE` env). Changing the directory mapping requires editing/republishing THAT project, not this one.

**Why:** this codebase is synced wholesale from the master repo (justinknox-SecureOpsDev/SecureOpsCommand); memory files imported with it may describe the master project's domains — for this project, always treat wcsgisecureops.com as production.

**APP_BASE_URL (production) must equal the current primary domain** — it builds every link inside reset / onboarding / amendment / invite emails. Changing production env vars requires a republish to take effect.

**Dev preview privacy** is a platform toggle, NOT code: Developer tools → Networking → "Private development URL".
