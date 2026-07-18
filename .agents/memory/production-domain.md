---
name: Production custom domain
description: Which domain is the real production URL and what drives links/CORS
---

The verified, live production custom domain (per Replit deployment `primaryUrl`) is **https://wcsgisecureops.com**. The `*.replit.app` address (security-operations-suite.replit.app) is a secondary URL that Replit auto-redirects to the custom domain — no redirect code needed.

**Gotcha:** `ALLOWED_ORIGINS` also lists `secureops.williamscouncilsg.com`, but that domain is NOT in the deployment's verified URL set — do not point email links at it (they may 404). Always use the deployment's `primaryUrl` (getDeploymentInfo) as the source of truth, not the CORS list.

**APP_BASE_URL (production) must equal the custom domain** — it builds every link inside reset / onboarding / amendment / invite emails. If it points at the replit.app host, users get replit.app links instead of the company domain. Changing production env vars requires a republish to take effect.

**Dev preview privacy** is a platform toggle, NOT code: Developer tools → Networking → "Private development URL". There is no code-only way to restrict the .replit.dev preview to the owner without breaking the owner's own workspace preview.
