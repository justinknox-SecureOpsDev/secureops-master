---
name: Prod stale front-door deploy
description: Diagnosing "domain root shows the app login instead of the marketing site"
---

**Signature:** the live domain root (`GET /`) returns the Expo web shell — `<title>SecureOps</title>` with a `/_expo/static/js/web/entry-*.js` script — and dumps the visitor on the mobile-app login. The CORRECT/current front door is the Vite marketing site: `<title>SecureOps — Workforce Operations…</title>` with `/assets/*.js` + `/assets/*.css`.

**Diagnosis:** this is a STALE DEPLOY, not a code bug. Current code cannot produce Expo-at-root: `scripts/build-single-vm.mjs` (run by `pnpm run build:vm`, the deploy build) builds only admin-portal + home and copies them to `artifacts/api-server/dist/static/{admin-portal,home}`; `lib/staticFrontends.ts` serves `home` at `/` and the admin portal at `/admin-portal/`; the `check-front-door` gate asserts it. So if the live root is the Expo app, the deployed bundle PREDATES the "serve the marketing site at the root domain" change and was never re-published.

**Why:** a change to front-door routing only takes effect after a republish — production keeps serving the last-published bundle indefinitely (Reserved VM, always-on). Editing the code is necessary but NOT sufficient.

**How to apply / confirm:** curl the live root and look at the title + script paths (`/_expo/static` = stale, `/assets/` = correct). To prove a fresh build is correct before telling the user to republish, run `pnpm --filter @workspace/scripts run check-front-door` (builds + boots the prod single-VM bundle locally and asserts `/` is the marketing shell, `/admin-portal/` is the admin shell, `/api/*` not shadowed). Fix = republish; no code change. NB: `fetch_deployment_logs` can return an older/failed deploy generation's lines ("Static frontend not found", `/api` 500) that don't match the instance actually serving — trust a live curl over those logs.
