---
name: Brand/config boot readiness gate
description: Why GET /api/brand must await the config-readiness signal instead of relying on fire-and-forget boot loads
---

# Brand + feature config must be ready before GET /api/brand answers

**Rule:** Any config that `GET /api/brand` surfaces from a *DB-loaded-at-boot*
source must be made ready on the shared config-readiness signal in
`artifacts/api-server/src/lib/configReadiness.ts` (`initConfigReadiness()` kicks
off the loads at boot; the `/brand` route `await whenConfigReady()` before
responding). Do NOT add a standalone fire-and-forget `loadXFromDb().then()` in
`index.ts` for a value that shows up in `/api/brand` or gates `requireFeature`.

**Why:** The server calls `server.listen` (opens the port) before the async
brand + feature override loads finish. With fire-and-forget loads, the first
`GET /api/brand` after a redeploy can win the race and return the *env baseline*
instead of the DB override. On forked/white-label tenants the env `COMPANY_NAME`
is a stale placeholder (e.g. "SecureOps Platform") while the real name lives as a
DB override — and the admin portal caches whatever it fetches first for the whole
session, so the placeholder sticks until a hard refresh. Same hazard for feature
flags (wrong nav/tab visibility on first load).

**How to apply:**
- Add the new loader to `loadConfigOverrides()` inside `configReadiness.ts` so it
  joins the same readiness promise; don't bypass it.
- The signal is `Promise.race([loads, timeout])` with a short timeout
  (`CONFIG_READY_TIMEOUT_MS`) so a slow/unavailable DB at boot can never hang the
  endpoint or startup — it falls back to env values, and later requests pick up
  the real values once the load completes.
- Keep the port opening promptly: `initConfigReadiness()` is non-blocking and
  runs after `server.listen`; only the `/brand` response awaits readiness.
- Note (as of this fix): `timeConfirmEditWindowHours` also rides in the
  `/api/brand` payload but is intentionally NOT on the readiness signal — scope
  was brand + feature overrides only. Revisit if that field's first-load
  staleness ever matters.
- The fix only takes effect on a deployment once it is republished with it.

**Test pattern:** `__tests__/brandBootReadiness.test.ts` uses the test-only
`__setConfigReadinessForTests(promise|null)` seam to gate the DB load behind a
manually-released promise, sleeps ~50ms so a non-awaiting (buggy) handler would
have already answered with the baseline, then releases the load and asserts the
response reflects the DB override — a deterministic regression guard.
