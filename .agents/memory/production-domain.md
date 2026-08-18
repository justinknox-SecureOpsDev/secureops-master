---
name: Production custom domain
description: Which domain is the real production URL for THIS deployment and what drives links/CORS
---

**This project is the WCSG customer deployment. Its live production URL is https://wcsgisecureops.com.** APP_BASE_URL and ALLOWED_ORIGINS must equal it (user-confirmed 2026-07-18 during the master-build sync).

**https://secureopscommand.com** (alias `SecureOps-Command.replit.app`) is the domain the mobile app is hardcoded to hit for org-code resolution (`DEFAULT_NATIVE_ORIGIN` in `artifacts/security-ops/utils/api.ts`, no `EXPO_PUBLIC_ORG_DIRECTORY_URL` override configured). **Confirmed by matching error-JSON shape + `/api/version` format (2026-08-18): that live domain runs an OLD api-server-style, `ORG_DIRECTORY`-env-driven directory lookup — NOT the newer database-backed control-plane code** (`control_plane_customers` table, different error strings). The org code for this backend is `wcsgi` (`ORG_CODE` env). Changing the directory mapping requires editing `ORG_DIRECTORY` + republishing THAT legacy project specifically.

**There is a THIRD, separate "SecureOps Control Plane" project with a real, DB-backed fleet dashboard/registry (`control_plane_customers` table) that the operator also uses day to day — but it is NOT what the live secureopscommand.com domain currently serves.** Its own agent, when asked to register a new org, correctly reports it can't do so itself and must be told to defer to "the original repl" (the legacy env-var project above). This repo's own `artifacts/control-plane` copy is a further, fourth, fully disconnected dev-only duplicate. Bottom line: three distinct SecureOps-related projects exist beyond this one (this repo, the legacy `ORG_DIRECTORY`-driven master at secureops-command.replit.app, and the newer DB-backed Control Plane project) — always verify which one you're editing via its actual behavior (error text / `/api/version`), not by title alone.

**Role swap (user-declared 2026-07-25): THIS project is now the MASTER for the SecureOps Command app** — it is the canonical publisher of OTA updates to the phone app (runtime 1.0.0, branch production) and the sole holder of EXPO_TOKEN / App Store credentials. The secureopscommand.com project is demoted to a demo; the user confirmed (2026-07-25) its `EXPO_TOKEN` was removed, so its deploys can no longer publish OTAs — the old "master project could clobber our OTA bundle" risk is CLOSED. The demo project still hosts the org directory, so it must stay deployed (or the directory must move here first if it is ever retired).

**Why:** this codebase is synced wholesale from the master repo (justinknox-SecureOpsDev/SecureOpsCommand); memory files imported with it may describe the master project's domains — for this project, always treat wcsgisecureops.com as production.

**APP_BASE_URL (production) must equal the current primary domain** — it builds every link inside reset / onboarding / amendment / invite emails. Changing production env vars requires a republish to take effect.

**Dev preview privacy** is a platform toggle, NOT code: Developer tools → Networking → "Private development URL".
