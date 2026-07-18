---
name: Expo web /api routing in dev
description: How the mobile web app reaches the API in the dev workspace — which origin actually routes /api.
---

The mobile web app always calls `window.location.origin + /api` (never the native runtime origin).

**Rule:** to verify or exercise mobile-web + API end-to-end in dev, go through `https://$REPLIT_EXPO_DEV_DOMAIN` — it serves the Expo web bundle AND routes `/api` (and `wss /api/ws`) to the api-server on 8080.

**Why:** raw Metro (local port / external port 3000) has NO `/api` proxy — it returns the SPA HTML shell with a misleading 200 for any `/api/*` request, so curl checks against Metro's port look half-working (200 but text/html). Also, the expo workflow runs `--localhost`, so Metro binds 127.0.0.1 and the external port-3000 proxy (and the screenshot tool) can't reach it at all.

**How to apply:** always check `content_type` (want application/json), not just status code; api-server CORS already allowlists the expo dev domain in `app.ts`.
