---
name: Fork → new-tenant deploy env reset
description: Publishing a forked copy of this template as a NEW tenant — the committed .replit [userenv.production] still holds the SOURCE tenant's prod env and silently breaks the new deployment.
---

# Fork → new-tenant deployment: reset production env

A forked repl inherits the source tenant's committed `.replit` `[userenv.production]` block. For this template that includes:

- `SEED_DEMO_USERS = "false"` — on a fresh empty DB this means `seedDemoUsers()` NEVER creates the master admin, so you are locked out of the new deployment with no way to log in.
- `APP_BASE_URL` / `ALLOWED_ORIGINS` — hardcoded to the source tenant's domain; outbound email links point at the wrong site and CORS lists the wrong origins.

**Rule:** before publishing a forked copy as a new tenant, clear those three from the **production** env scope (they live in `.replit [userenv.production]`; remove via the env tooling). Keep `PORT` + `NODE_ENV`. Leave seeding ON for the first boot so the master admin is created, then optionally set `SEED_DEMO_USERS=false` after first login.

**Why:** `APP_BASE_URL` falls back to `REPLIT_DOMAINS`, and CORS auto-adds `REPLIT_DOMAINS`, so removing the hardcoded source-domain values lets the new deployment self-resolve to its own `*.replit.app`. Seeding-off on an empty DB = permanent lockout (no admin ever created).

**How to apply:** same checklist for every new customer backend in the multi-org onboarding runbook (Rich Guardian Protection / org `rgp` and beyond): fresh DB, seeding ON for first boot, per-tenant `DEMO_ADMIN_*` + `SUPER_ADMIN_EMAILS`, then turn seeding off once confirmed.

## Tenant admin login "invalid credentials" after fork

Secrets do NOT carry over on fork (they're per-repl, not committed to `.replit`). So a new tenant has NO `DEMO_ADMIN_PASSWORD` unless you set one → `brand.demoAdminPassword` falls back to the hard-coded seed default password (a known constant in the seed source). Meanwhile `DEMO_ADMIN_EMAIL`/`SUPER_ADMIN_EMAILS` ARE inherited (shared `[userenv]` is committed), so the seeded admin email is the source tenant's unless changed. Net: a fresh tenant's super-admin is usually `<inherited DEMO_ADMIN_EMAIL>` / the seed-default password IF seeding ran. If login still fails, seeding never created the admin (inherited `SEED_DEMO_USERS=false` on the empty DB — see Rule above): flip seeding ON, set per-tenant `DEMO_ADMIN_EMAIL` + the `DEMO_ADMIN_PASSWORD` secret + `SUPER_ADMIN_EMAILS`, then REPUBLISH so `seedDemoUsers()` creates/resets it. The hub repl CANNOT read/modify a tenant's env, secrets, logs, or DB — every fix runs on the tenant's own repl.

## Diagnostic: new tenant root 200 but /api/* 500

If a freshly published tenant serves its SPA (`GET /` → 200) but every DB-backed API call 500s (`GET /api/brand` → 500 consistently, not just during a redeploy window), the schema was **not pushed** to that tenant's DB (or `DATABASE_URL` isn't pointing at the tenant's own fresh Postgres). Static file serving needs no DB; brand/auth/everything else does. Fix on the TENANT's deployment: confirm its `DATABASE_URL`, run `pnpm --filter @workspace/db run push` against it, then verify `/api/brand` → 200 before activating its org code in the hub `ORG_DIRECTORY`. The hub directory entry is independent and harmless to set first, but the org is unusable until the tenant's API is healthy. Tenant logs are NOT reachable from the hub repl (`fetch_deployment_logs` only sees the hub's own deployment) — the user must check the tenant's deployment logs.
