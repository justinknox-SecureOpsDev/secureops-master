---
name: Prod "Failed to load" transients
description: Why SecureOps shows "Failed to load X" in prod even though the API is healthy
---

# "Failed to load …" in production = redeploy restart window, not a backend bug

**Symptom:** Users see "Failed to load dashboard / employees" cards (with Retry) in
the SecureOps app at the custom domain, even on strong signal.

**Root cause (observed twice):** the failures coincide with a publish/redeploy. The
API is deployed as a **Reserved VM**; redeploying it stops the old instance and boots
a new one, leaving a few-second window where in-flight requests fail. React Query then
holds the error state until the user taps Retry. Deployment logs show a single clean
boot at the failure time with no crashes after — and the endpoints return 200 fast
when probed directly.

**Why:** publishing the app (incl. TestFlight updates) republishes the whole monorepo
deployment, restarting the API. Brief downtime is expected on redeploy.

**How to confirm fast (no code change needed):**
- `curl https://<prod-domain>/api/healthz` and the failing endpoint with a real admin
  Bearer token + `Origin:` header → expect 200s, fast, stable.
- Check deployment logs for restart/crash events around the failure timestamp; a single
  boot with no errors after = transient redeploy window, not a defect.

**Web-build note:** the Expo **web** surface resolves its API base from
`window.location.origin` (see `utils/api.ts resolveApiBaseUrl`), so at the custom domain
it is same-origin — CORS is not involved. The deployed `web-dist` can be STALE (older
hardcoded fallback domains baked in) yet still work, because web uses window.origin and
the bundled endpoint paths still match the server. Stale web-dist is hygiene, not the
cause of these transients. Rebuild web-dist if the web surface needs current code.
