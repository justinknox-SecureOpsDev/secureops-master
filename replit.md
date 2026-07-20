# Williams Council Security Group — SecureOps Platform

Multi-org mobile + web security-ops platform: recruitment → onboarding → scheduling → live ops → payroll/invoicing → audit. ONE shared mobile build serves many customers; **this project is the canonical WCSG customer backend**.

**Stack:** pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · ws · PostgreSQL + Drizzle · Zod v4 · Expo Router v6 · Orval (OpenAPI codegen) · esbuild.

## User preferences

- Brand: black `#0c0a08`, rich metallic gold `#c9a04a` (true gold, hue ~41°, matched to the WCSG eagle logo — deliberately NOT orange (<35°) and NOT muted/flat bronze; both were rejected), warm cream `#f0e4c0`. Marketing hero/CTAs: 3-stop metallic gradient `#f0d89a`→`#c9a04a`→`#aa8036` with inset top highlight. Deep black + bright gold contrast is intentional; card/glow darks are near-neutral warm charcoals. Token identifiers stay named navy/gold/cream in code (values only — no rename).
- Company: Williams Council Security Group (WCSG). Currency: USD ($).

## Quick reference

| Command | Purpose |
| --- | --- |
| `pnpm --filter @workspace/api-server run dev` | API server (port 8080) |
| `pnpm --filter @workspace/api-spec run codegen` | Regen API hooks + Zod from OpenAPI |
| `pnpm --filter @workspace/db run push` | Push DB schema (**re-run after every schema change**) |
| `pnpm run typecheck` / `pnpm run build` | Workspace-wide TS check / build |

- **Contract-first**: edit `lib/api-spec/openapi.yaml` (source of truth) → codegen React Query hooks (`lib/api-client-react`) + Zod (`lib/api-zod`) → server validates with the generated zod.
- **Always `db push` after a schema change** — forgetting also trips the `schema-drift` release gate (the fix is push, not code).
- **WS**: `wss://<domain>/api/ws?token=<jwt>` — chat delivery; JWT revocation-checked on upgrade.
- Monorepo structure, TS project refs, dependency conventions: see the `pnpm-workspace` skill.

## Codebase map

- **DB schema** — `lib/db/src/schema/` (users, employees, clients, sites, shifts, shiftAssignments, timeEntries, payrollEntries, invoices, incidents, licenses, chat*, applications + tokens, revokedTokens, auditLogs, platformSettings).
- **API server** — `artifacts/api-server/src/`: `routes/` + `lib/` (wsManager, push, sms, geofence, objectStorage, email, auditLog, scheduledJobs, eligibility, invoiceSync, holidays, brandConfig…).
- **Admin portal** — `artifacts/admin-portal/` (React+Vite at `/admin-portal/`); `lib/tables.ts` drives the generic CRUD grids.
- **Mobile (Expo)** — `artifacts/security-ops/`: `app/(employee)/` + `app/(admin)/` (5 tabs each).
- **Marketing site** — `artifacts/home/`.
- **Control plane** — `artifacts/control-plane/` (operator-only fleet console; separate deployment — see below).

## Domain rules

- **Client → Site → Shift**: clients have payment terms (Net X days); shifts carry `payRate` (officer), `billRate` (client; admin/dispatcher-only — sanitize before non-admin reads), `requiredLicenseLevel`, `headcount`.
- **Licenses**: L2 unarmed → L3 armed → L4/PPO; higher covers lower. Effective level = `GREATEST(max unexpired license level, support_staff?1:0)` (`lib/eligibility.ts`).
- **Shifts stay `status='upcoming'` forever** (never auto-advanced) — every "upcoming" query MUST add a time bound (`endTime >= now`) or past shifts leak.
- **Shift claim is atomic** (tx + `FOR UPDATE` + headcount re-check); decline DELETES the assignment to free the slot. Any path creating an accepted assignment must apply the same license gate.
- **Geo clock-in**: without `shiftId`, nearest site within 1 mile (haversine), else `422 No Site Nearby`. Live geofence checks each `/me/location` ping vs the active shift's site (`GEOFENCE_RADIUS_MILES`, default 0.25); exit → push + SMS to admins, resets on return.
- **Emergency button**: 3s hold → `POST /emergency` → critical incident + push/SMS to admins; dials `EMERGENCY_CALL_NUMBER` or `911`.
- **Chat**: type-driven channels (`announcements|ops|license_level|city|elite`); mobile's legacy `type:"general"` aliases to `announcements`; `joinPolicy` derived server-side. Template ships NO default channels; per-site channels auto-seed; seeding only retires legacy rooms (never promotes); retired rooms hidden everywhere.
- **SMS** (additive to push): only when Twilio connected AND `users.phoneNumber` (E.164) AND `users.smsOptIn`. **Emergency contacts are NEVER texted** — `*.emergency_contact_phone` are call-only paper-trail fields (TCPA).
- **Client incident share links**: sanitized public read-only view (NEVER adminNotes, officer email/phone, or full name — "F. Last" only); 32-byte token, 30d default, revocable; fails closed without a base URL.
- **Audit log** records every 2xx write on privileged paths (sensitive keys redacted). **Scheduled jobs** (token cleanup, license-expiry reminders, invoice locking, pre-shift reminders) each use an in-process mutex + atomic UPDATE-RETURNING claim.

## Money

- **All workers are 1099 — payroll NEVER withholds tax.** `tax=0`, `netPay=grossPay` at compute, read (incl. legacy normalization), and write. The DB/API `tax` field stays but is always `0`.
- **Pay-rate priority**: `time_entries.pay_rate_override` → `shifts.payRate` → `employees.hourlyRate` → $0 (warning). Bill rate: `shifts.billRate` → `sites.defaultBillRate` → refuse (400).
- **Invoicing is auto + idempotent**: each time-entry approval upserts a `draft` invoice keyed (`siteId`, ISO-week Monday 00:00 UTC), rebuilding line items from that week's approved entries; admin-grid time-entry CRUD fires the same sync (a moved entry also rebuilds its OLD bucket). Admin edit of billable fields flips `auto_synced=false`; ended weeks lock hourly; a late approval for a locked week opens a new adjustment draft. Due = today + client payment terms.
- **Federal holidays 1.5×** (payroll AND billing): match the **actual** holiday date (a Sat July 4 stays July 4), qualify the whole entry by clock-in date in `PAYROLL_TIMEZONE` (default `America/Chicago`), round the premium rate to cents BEFORE × hours.
- **Pay Run** (`/admin-portal/payroll/pay-run`): pending → processed (atomic on CSV export) → paid; rows missing bank details/name/DD consent or with zero/negative net are excluded. Stripe path 501 unless `STRIPE_CONNECT_ENABLED=true`. Bank cols keep UK names (`bankBsb` etc.) with US labels.
- **Analytics** (`/admin-portal/analytics`, admin-only, ungated core): same money rules + CSV/PDF export. Known cosmetic divergence: analytics weekly buckets use business-TZ Mondays, invoices key UTC Mondays — Sunday-evening entries can chart in a different week than they invoice; range totals agree (not a bug).

## HR pipeline

- Public apply (`/admin-portal/apply`, no auth, rate-limited; files via presigned upload URLs) → admin review (`/admin-portal/hr/applications`) → **approve** creates pending `User` + `Employee` + `License` and mints a 14-day single-use onboarding token (re-provisions an existing user only if employee + pending/inactive; else 409) → public onboarding (`/admin-portal/onboard/:token`) collects bank/tax/docs/signature, copies bank+emergency contact to `employees`, activates the user, consumes the token.
- **Request more info** mints a 14-day single-use amendment token (`/admin-portal/amend/:token`); amendment enforces the requested fields, applies atomically, bumps status to `under_review`.
- **Invitations** (`/admin-portal/hr/invitations`): two-phase — generate bulk temp passwords (plaintext stored until sent, `must_change_password=true`) then send invite emails (clears plaintext). Only `/admin/users/invitations` returns temp passwords; generic users grid strips them. Admins are never targeted.
- **UK→US naming**: some DB cols keep UK names (`sia_license_*`, `ni_number*`, `p45_doc_key`, `bankBsb`) — UI labels are TX/US.

## Platform & multi-tenancy

- **Branding (super-admin)**: Platform → Branding edits the `platform_brand_config` singleton live (no redeploy); `lib/brandConfig.ts` merges env defaults ← non-null DB overrides, patched in-process. Super-admin = `SUPER_ADMIN_EMAILS` CSV (falls back to seeded admin email). Overridable: company/short/app names, tagline, company license # (`companyLicense`, env `COMPANY_LICENSE` — rendered verbatim only when non-empty across portal header, mobile profile, home footer, email signatures/footers, and all 4 PDFs), 3 brand colors, billing/hr/adminNotify emails, logo (`data:image/*` ≤~512 KB). Env-only: salesEmail, privacyEmail, demo credentials. Public `GET /api/brand` (`no-store`) serves text/colors/logo + feature flags; portal CSS vars and all 4 PDFs read it live. **Pre-auth login stays fixed "SecureOps Command"** (per-tenant brand only post-auth; defaults stay WCSG so the a11y gate holds).
- **Multi-org**: ONE app-store build, many fully separate customer deployments (own API + DB + branding) — never one server routing many DBs. The app resolves a short org code via public `GET /api/org-directory/resolve?code=` to a backend ORIGIN (routing convenience, NOT auth; dev synthesizes unknown codes, prod 404s), persists it on-device, and routes all native traffic there (native ignores build-time `EXPO_PUBLIC_API_BASE_URL` — the runtime origin is OTA-safe). Web always talks to its own origin. `ORG_DIRECTORY` env (JSON array, memoized — redeploy to refresh) lives on the directory deployment; `ORG_CODE` on each customer backend powers its invite QR/link surface (`/connect?code=…`, validated against the directory, single-shot auto-resolve). Switch-org clears stored org + brand/feature cache + runtime origin.
- **New-customer runbook**: (1) fresh Postgres + `db push`; (2) separate Reserved-VM publish; (3) env: `DATABASE_URL`, `SESSION_SECRET`, `ALLOWED_ORIGINS`, `APP_BASE_URL`, SMTP, `DEMO_ADMIN_EMAIL` + `DEMO_ADMIN_PASSWORD` secret, `SUPER_ADMIN_EMAILS` — **leave seeding ON for first boot** so the master admin is created, then optionally disable; (4) set branding in-app; (5) register the org code in `ORG_DIRECTORY` (+ set `ORG_CODE` on their backend) and redeploy the directory backend; (6) register in the control plane with a `mgmtSecret` = `CONTROL_PLANE_SHARED_SECRET` on their backend.
- **Control plane**: operator-only fleet console with its own DB + secrets; registry tables created idempotently on boot (kept out of `@workspace/db` so schema-drift never sees them). Dev workflow runs on port 9999 with shared-DB fallbacks. **Deploys as its OWN separate Replit project** — a second `deploymentTarget="vm"` artifact here would crash-loop this deploy, so the artifact stays dev-only in this project. Prod boot fails fast without `CONTROL_PLANE_{DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY, OPERATOR_EMAIL, OPERATOR_PASSWORD|_HASH, ALLOWED_ORIGINS}`. Customer `mgmtSecret`s stored encrypted; a customer backend without its shared secret keeps `/api/control-plane/*` inert (503). Remote-change history pruned after `CONTROL_PLANE_REMOTE_CHANGE_RETENTION_DAYS` (default 180).

## Security & operations

- **Baseline** (full detail in `threat_model.md`): CORS = `ALLOWED_ORIGINS ∪ REPLIT_DOMAINS` (no-Origin native/curl allowed); Helmet with cross-origin resource policy, CSP in production only; rate limiters on login, forgot-password, public application, token lookup, emergency, upload-URL; JWT revocation via `users.tokens_valid_after` watermark + `revoked_tokens(jti)`, checked in `requireAuth` AND the WS upgrade; `GET /admin/system/status` drives an amber degraded-config banner; public legal pages at `/admin-portal/{privacy,terms,data-rights,eula}`.
- **Deployment: Reserved VM (always-on), NOT Autoscale** — the API is stateful (WS registry + job mutex). api-server must stay the ONLY `deploymentTarget="vm"` artifact. Single-port layout: marketing at `/`, admin portal at `/admin-portal/`, **mobile web app at `/app/`** (Expo web export; `build-single-vm.mjs` runs it with `EXPO_WEB_BASE_URL=/app`, which `app.config.js` maps to `experiments.baseUrl` only when set — dev/EAS/OTA unaffected), API at `/api`. The `front-door` gate asserts all four surfaces. Required env: `DATABASE_URL`, `SESSION_SECRET` (≥16 chars; prod hard-fails). Optional: `ALLOWED_ORIGINS`, `APP_BASE_URL`, `SMTP_*`, `EMERGENCY_CALL_NUMBER`, `GEOFENCE_RADIUS_MILES`, `SEED_DEMO_USERS=false`, `STRIPE_CONNECT_ENABLED`, `GEOCODING_ENABLED`, `PAYROLL_TIMEZONE`, `EMAIL_DEV_SEND` (dev only), `ORG_CODE`.
- **Outbound email only sends in production** (dev SMTP secrets ARE the prod mail account — dev sends would hit real inboxes); `EMAIL_DEV_SEND=true` forces a single real dev run.
- **Validation gates** (any failure blocks release): `typecheck` · `test` (workspace Vitest) · `security-headers` · `schema-drift` (fix = `db push`) · `a11y` (axe + Playwright, admin portal) · `a11y-mobile` (screen-reader-label lint).
- **Seeded accounts** (idempotent each boot via `seedDemoUsers()`; disable with `SEED_DEMO_USERS=false`): master admin = `DEMO_ADMIN_EMAIL` + `DEMO_ADMIN_PASSWORD` secret (this deployment: `justin.knox@williamscouncil.com`; also the super-admin) — point at the customer's own admin before a new copy's first boot. Demo staff: `officer@secureops.com`/`Employee123!`, `lead@secureops.com`/`Lead123!`, `guest@secureops.com`/`Demo123!` (mobile "Try Demo").

## Gotchas

- Orval: list hooks take `(params, { query: { queryKey } })`; mutation hooks take `{id, data}`. Codegen post-step rewrites `lib/api-zod/src/index.ts` to re-export only `./generated/api`.
- expo-notifications warns on web but doesn't crash — push registration skipped on web.
- Admin grid derived "name" cells: `derived.linkRoute` opens a route; `derived.linkTo` filters a grid — never point `linkTo` at its own table (self-filters, looks like a no-op).
