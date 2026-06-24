# Williams Council Security Group — SecureOps Platform

Mobile + web operations platform for WCSG: recruitment → onboarding → scheduling → live ops → payroll/invoicing → audit.

**Stack:** pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · ws · PostgreSQL + Drizzle · Zod v4 + drizzle-zod · Expo Router v6 · Orval (OpenAPI codegen) · esbuild.

## User preferences

- Brand: deep navy `#080c18`, rich gold `#c9a84c`, warm cream `#f0e6c8`
- Company: Williams Council Security Group (WCSG)
- Currency: USD ($)

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm --filter @workspace/api-server run dev` | API server (port 8080) |
| `pnpm --filter @workspace/api-spec run codegen` | Regen API hooks + Zod from OpenAPI |
| `pnpm --filter @workspace/db run push` | Push DB schema (**re-run after every schema change**) |
| `pnpm run typecheck` / `pnpm run build` | Workspace-wide TS check / build |

## Where things live

- **DB schema** — `lib/db/src/schema/` (users, employees, clients, sites, shifts, shiftAssignments, timeEntries, payrollEntries, invoices, incidents, licenses, chatRooms, chatMessages, applications, onboardingTokens, onboardingSubmissions, applicationAmendmentTokens, revokedTokens, auditLogs).
- **API contract** — `lib/api-spec/openapi.yaml` (source of truth) → `lib/api-client-react/src/generated/` (React Query hooks) + `lib/api-zod/src/generated/api.ts` (Zod).
- **API server** — `artifacts/api-server/src/`: `routes/` (auth, applications, chat, admin, storage, liveOps, payroll, shifts, incidents, audit, myPayroll, …); `lib/` (`wsManager` at `/api/ws`, `push`, `sms`, `geofence`, `objectStorage`+`objectAcl`, `email`, `auditLog`, `scheduledJobs`, `seedDemoUsers`, `incidentPdf`, `eligibility`, `invoiceSync`, `holidays`).
- **Admin portal** — `artifacts/admin-portal/` (React+Vite, mounted at `/admin-portal/`). `lib/tables.ts` drives the generic CRUD UI; `components/{DataGrid,RowFormDialog,ImportWizard,FileUploadField,BrandHeader,RepeatingShiftDialog}.tsx`; `pages/` (Apply, Onboard, AmendApplication, Applications, Onboarding, Policies, PayRun, Invitations, Shifts, AuditLog, SiteDetailPage, OfficerProfile, ResetPassword, Legal).
- **Mobile (Expo)** — `artifacts/security-ops/`: `contexts/ChatContext.tsx`, `hooks/useNotifications.ts`, `app/(employee)/` (5 tabs) + `app/(admin)/` (5 tabs), `app/paystubs.tsx`, `components/{EmergencyButton,LiveOfficerMap,chat/}`.

## Architecture

- **Contract-first**: edit OpenAPI yaml → regen hooks + zod → server validates with zod.
- **WebSocket** at `/api/ws?token=<jwt>` — chat broadcast; JWT revocation-checked on upgrade.
- **Push**: `expo-server-sdk`; tokens in `users.expoPushToken`; web/sim degrade gracefully.
- **SMS** (additive to push): fires only when Twilio connected AND `users.phoneNumber` (E.164) AND `users.smsOptIn=true`. **Emergency contacts are never texted** — `*.emergency_contact_phone` are call-only paper-trail fields; `sendSmsToUsers` reads `users` only, `sendSmsToPhoneNumber` refuses emergency-contact numbers (TCPA/privacy: no consent, no opt-out).
- **Roles**: admin = 5 tabs (Dashboard, Personnel, Shifts, Incidents, Chat); employee = 5 tabs (Home, My Shifts, Clock, Incidents, Chat). `dispatcher` = global scheduling staff. `site_manager` (display "Site Manager", renamed from legacy `lead`) = employee + scheduling powers scoped to assigned sites only (see next bullet). Role is TEXT (no pg enum); legacy `lead` rows are migrated by an awaited boot data-repair (`lib/dataRepairs.ts`) before `listen()`.
- **Site managers (per-site scoping)** (`lib/siteManagerAuth.ts`, `site_managers` join table): many-to-many manager↔site; admins assign on SiteDetailPage. A `site_manager` may list/read/create/edit/delete shifts, manage assignments, and approve/reject time-entries ONLY at assigned sites (`getManagedSiteIds` / `assertCanManageSite`; admin + dispatcher bypass; **fails closed** when site membership is unresolved). Notified (push + SMS) on shift create AND pending claim, scoped to their sites (deduped with admins). **Finance/PII boundary**: never see OTHER people's finance (pay/bill rate stripped) or other-site PII — `GET /clients` is scoped to clients owning a managed site with billing/contact stripped; `siteRateId` (rate-card link) is forced null on their shift create and ignored on edit, and a cross-site move recomputes pay/bill from the destination site's defaults (fail-closed) so no admin-set finance carries across sites (**response-strip ≠ write-block**). A site manager DOES see their OWN pay/paystubs like any employee.
- **Audit log** (`lib/auditLog.ts`): records every 2xx write on privileged paths. Sensitive keys redacted, body capped 8 KB. Read via `/admin/audit-logs`.
- **Scheduled jobs** (`lib/scheduledJobs.ts`): hourly revoked-token cleanup, license-expiry reminders (30/14/7d), `lockEndedWeekInvoices`; 5-min pre-shift reminders (~2h, ~30m). Each uses an in-process mutex + atomic UPDATE-RETURNING claim; failed deliveries roll back for retry.

## Product

- **Client → Site → Shift hierarchy**: clients have payment terms (Net X days); sites are physical locations; shifts post against a site with `payRate` (officer), `billRate` (client), `requiredLicenseLevel`, `headcount`.
- **License hierarchy**: L2 unarmed → L3 armed (covers L2+L3) → L4/PPO (covers all). `maxLicenseLevel` = MAX(level) of unexpired licenses.
- **Eligibility / Support Staff** (`lib/eligibility.ts`): `employees.position` (`officer` | `support_staff`). Shifts may require level 1 (support, no licence). Effective level = `GREATEST(maxLicenseLevel, support_staff ? 1 : 0)`; higher covers lower. `effectiveLevelSql` needs `licensesTable` **and** `employeesTable` left-joined on `users.id`. Used by all eligibility surfaces. Set position at `/admin-portal/tables/employees`.
- **Shifts** stay `status='upcoming'` forever (never auto-advanced), so any "upcoming" query MUST add a time bound (convention: `endTime >= now`) or past shifts leak.
- **Atomic shift claim** (`POST /shifts/:id/claim`): tx + `SELECT … FOR UPDATE` + headcount re-check before insert. One-tap Reserve creates `accepted`; Decline DELETES the assignment to free the slot.
- **Repeating shifts** (`POST /shifts/repeat`): expand `{startDate, untilDate, daysOfWeek[0..6], startTime/endTime}` (cap 366; overnight wrap when end ≤ start). Idempotent per site + exact `startTime`.
- **Geo clock-in** (`POST /time-entries/clock-in {lat,lng,shiftId?}`): without `shiftId`, resolves nearest site within 1 mile (haversine); `422 No Site Nearby` if outside.
- **Live geofence**: each `/me/location` ping (~1/min while clocked in) checks officer vs active shift's site (`GEOFENCE_RADIUS_MILES`, default 0.25). First inside→outside → push + SMS to admins; resets on return.
- **Open vacancies**: dashboard lists upcoming shifts where `filled<headcount`. `POST /shifts/:id/notify-vacancy` pushes qualifying officers.
- **Live map**: admin tab, Leaflet/OSM (web) or list (native), 30s refresh; mobile pings `/me/location` every 60s. `GET /admin/active-officers`.
- **Emergency button**: 3s hold on employee Home → `POST /emergency` → critical incident + push/SMS to admins; returns `callNumber` (`EMERGENCY_CALL_NUMBER` or `911`), dialed via `Linking.openURL("tel:…")`.
- **Chat**: real-time named channels, persistent history, WS delivery.
- **Notifications**: shift assignment, vacancy, geofence breach, emergency, license expiry (30/14/7), pre-shift (2h, 30m).
- **Officer paystubs**: mobile Profile → My paystubs (`GET /me/payroll`), with YTD/lifetime totals.
- **Client incident share links**: admin mints a no-login per-incident URL (`/admin-portal/incidents/share-links`); public view at `/admin-portal/share/incident/:token` is sanitized read-only (NEVER adminNotes, officer email/phone, or full name — reduced to "F. Last"; PDF mirrors via `{ redactForPublicShare: true }`). Token = 32 random bytes, 30d default, revocable, view-counted. Rate-limited; minting fails closed (503) without `APP_BASE_URL`/`REPLIT_DOMAINS`.

### Invoicing

- **Auto-populated + idempotent**: each time-entry approval fires `lib/invoiceSync.upsertWeeklyInvoiceForTimeEntry` — finds-or-creates a `draft` invoice keyed on (`siteId`, `periodStart`=Monday 00:00 UTC) and rebuilds line items from all approved entries that ISO week. Rejection re-syncs. Manual `POST /invoices/generate {siteId, weekStart}` uses the same upsert. Rate = `shifts.billRate` → `sites.defaultBillRate` → refuse (400). Due = today + `clients.paymentTermsDays`.
- **Federal-holiday billing (1.5×)**: hours whose clock-in date (in `PAYROLL_TIMEZONE`) land on a US federal holiday bill at `billRate × 1.5` (rounded to cents) in their own line item. Calendar in `lib/holidays.ts`.
- **Lifecycle**: syncable iff `status='draft' AND locked_at IS NULL AND auto_synced=true`. Admin edit of billable fields flips `auto_synced=false`. Hourly `lockEndedWeekInvoices` stamps `locked_at` once `period_end < today`; a late approval for a locked week opens a new adjustment draft (partial unique index `invoices_active_auto_draft_per_week_idx`). Race-safe on `23505`.

### Payroll

- **All workers are 1099 contractors — payroll NEVER withholds tax.** `tax = 0` and `netPay = grossPay` everywhere, always — enforced at **compute** (`/payroll/generate` + board process), **read** (`/payroll` list, pay-run preview/export, officer `/me/payroll` incl. YTD/lifetime, admin CSV — all normalize legacy rows on read), and **write** (admin `payroll_entries` `coerceWrite` forces it; editable Tax field removed from the grid). The DB `tax` column + API `tax` field stay but are always `0`.
- **Rate priority**: `time_entries.pay_rate_override` → `shifts.payRate` → `employees.hourlyRate` → $0 (warning). Backfill via Payroll Board "Apply pay rate" (`POST /payroll/board/apply-rate`, admin-only, audited; refuses processed/paid). Pay Run re-runs `computeBoardBuckets` at process time.
- **Federal-holiday pay (1.5×)**: hours whose clock-in date (in `PAYROLL_TIMEZONE`) land on a US federal holiday pay at `baseRate × 1.5`. Whole-entry qualification by clock-in date (no midnight split). Board shows amber "Holiday 1.5×" badge. Policy in `lib/holidays.ts`.
- **Pay Run** (`/admin-portal/payroll/pay-run`): pending → processed (after CSV export) → paid.
  - `/payroll/pay-run/preview {ids[]}` → rows + per-row warnings (missing bank/routing/name, no DD consent, zero/negative net); warnings + already-paid excluded from CSV.
  - `/payroll/pay-run/export-csv {ids[], batchReference?}` → `wcsg-payroll-<batch>.csv`; atomically marks payable rows `processed`/`ach_csv`/`paymentReference`. Idempotent.
  - `/payroll/pay-run/mark-paid {ids[], …}` → `paid` (default method `manual`).
  - `/payroll/pay-run/stripe` → 501 unless `STRIPE_CONNECT_ENABLED=true` (needs flag + `STRIPE_SECRET_KEY` + employee `stripeAccountId` + `stripe.transfers.create()`).
  - Bank source: `employees.bankAccountName / bankAccountNumber / bankBsb` (UK column names, US labels); `directDepositConsent` must be true.

## HR pipeline (recruitment → onboarding)

- **Public application** (`/admin-portal/apply`) — multi-step; files via presigned URL (`POST /api/storage/uploads/request-url` → PUT to GCS); submits to `POST /api/applications` (no auth, rate-limited).
- **Admin Applications** (`/admin-portal/hr/applications`) — filter/search, review, under-review/reject/approve, batch "Request more info".
- **Approve** creates `User` (employee, status=`pending`, temp pw) + `Employee` + `License` (if TX info), mints 14-day single-use `OnboardingToken`. Re-provisions an existing user only if `role==='employee'` AND status `pending`/`inactive`; else 409.
- **Public onboarding** (`/admin-portal/onboard/:token`) — prefilled; submits bank/tax/W-2/emergency contact/uniform/docs + signature + 4 acknowledgements. Copies bank+emergency to `employees`, sets user `active`, consumes token. (DB cols keep UK names — `sia_license_*`, `ni_number*`, `p45_doc_key` — UI labels are TX/US.)
- **Admin Onboarding** (`/admin-portal/hr/onboarding`) — pending vs completed, detail dialog, resend link.
- **Request more info**: `POST /admin/applications/:id/request-info {fields[], note?}` mints 14-day single-use `application_amendment_tokens`, status → `info_requested`, emails `/admin-portal/amend/:token`. `POST /applications/amend/:token` enforces all requested fields, applies atomically, bumps to `under_review`. Batch parallel (cap 4).

## Invitations (bulk temp passwords + invite emails)

- Page `/admin-portal/hr/invitations`. Two-phase; admins NEVER targeted.
- **Generate** — `POST /admin/users/bulk-temp-passwords {scope, userIds?, force?}`: 10-char pw (avoids 0/O/1/I/l), bcrypt → `password_hash`, plaintext → `temp_password_plain`, `must_change_password=true`.
- **Send** — `POST /admin/users/bulk-invite {userIds[]}`: emails sign-in URL + email + temp pw, clears `temp_password_plain`, stamps `invited_at`.
- `GET /admin/users/invitations` returns `tempPasswordPlain` (admin-only). Generic `/admin/tables/users` strips `passwordHash` + `tempPasswordPlain`. Sign-in URL from `APP_BASE_URL` (preferred) or `REPLIT_DOMAINS`.

## Security baseline

- **CORS** locked to `ALLOWED_ORIGINS ∪ REPLIT_DOMAINS`; no-Origin (native/curl) allowed.
- **Helmet** with `crossOriginResourcePolicy: cross-origin` (signed downloads embed). CSP in production only.
- **Rate limiters** (`middlewares/rateLimit.ts`): login (10/15min), forgot-password (5/hr), public-application (5/hr), token-lookup (60/5min), emergency (5/min/user), upload-URL (per-IP cap).
- **JWT revocation** (checked in `requireAuth` AND on `/api/ws` upgrade): (1) `users.tokens_valid_after` watermark — bumped by `/auth/logout-all` or admin `revoke-sessions`; (2) `revoked_tokens(jti)` — written by `/auth/logout`. Hourly cleanup.
- **System status**: `GET /admin/system/status` (admin) → SMTP / SESSION_SECRET / base-URL / CORS booleans. Admin shell shows amber banner when degraded; boot logs `error` per missing prod requirement.
- **Public legal pages**: `/admin-portal/{privacy,terms,data-rights}`, linked from Apply, admin Login, mobile login.
- **DB indexes** on hot paths: `shifts(siteId,startTime)`, `shiftAssignments(shiftId,status)`, `timeEntries(employeeId,clockInTime)`, `chatMessages(roomId,createdAt)`, `incidents(employeeId,occurredAt)`, `revokedTokens(userId)`, `revokedTokens(expiresAt)`.

## Deployment

- **Target: Reserved VM (always-on), NOT Autoscale.** The API is stateful (in-process WS registry + scheduled jobs with a boot mutex); scale-to-zero / multi-replica causes uptime dips, dropped WS, and double-firing jobs. `artifacts/api-server/.replit-artifact/artifact.toml` declares `deploymentTarget = "vm"`; the top-level publish target must also be Reserved VM.
- **Required env**: `DATABASE_URL`, `SESSION_SECRET` (≥16 chars; production hard-fails if missing/short).
- **Optional env**: `ALLOWED_ORIGINS`, `APP_BASE_URL`, `SMTP_HOST/PORT/USER/PASS/FROM` (set all to enable outbound mail; without them endpoints return `emailSent:false` + a URL to share manually), `EMERGENCY_CALL_NUMBER`, `GEOFENCE_RADIUS_MILES`, `SEED_DEMO_USERS=false`, `STRIPE_CONNECT_ENABLED`, `GEOCODING_ENABLED` (US Census geocoding for the distance-from-site filter), `PAYROLL_TIMEZONE` (IANA tz for holiday-pay date resolution; default `America/Chicago`), `EMAIL_DEV_SEND=true` (dev/test only — force real email delivery; see below).
- **Outbound email only sends in production.** `sendEmailDetailed` (the single mail chokepoint in `lib/email.ts`) suppresses all sends unless `NODE_ENV='production'`, logging an info line instead. This stops the dev workspace / test runner from flooding the real admin/HR inboxes on every restart, scheduled job, or exercised code path (the dev SMTP secrets ARE the production mail account). Set `EMAIL_DEV_SEND=true` for a single run to deliberately test the live pipeline in dev.

### Validation gates (CI — any failure blocks release)

- **`typecheck`** — `pnpm run typecheck`.
- **`test`** — `pnpm -r --if-present run test` (api-server / admin-portal / security-ops Vitest). Self-contained: no workflow / DB / device.
- **`security-headers`** — builds api-server, asserts helmet CSP / CORS / HSTS / COR-P.
- **`schema-drift`** — `scripts/src/check-schema-drift.ts` introspects every table/enum exported from `@workspace/db/schema` and asserts the live DB matches on: missing table/column, type mismatch, nullability, missing named index, missing enum/value, default drift, FK drift (incl. `onDelete`). Normalises whitespace/casts so equivalent forms don't false-positive; ignores extra DB-only objects. Fails fast naming each object + the `db run push` remedy. Needs `DATABASE_URL`. **A forgotten `db push` after a schema change trips this (and later `test`/`security-headers`) — the fix is push, not code.**
- **`a11y`** — axe-core + Playwright/Chromium over key Admin Portal surfaces; fails on any critical/serious WCAG 2.1 A/AA violation. Self-bootstrapping (spawns api-server + admin-portal, auto-seeds admin). Override via `A11Y_BASE_URL` / `A11Y_ADMIN_EMAIL` / `A11Y_ADMIN_PASSWORD`.
- **`a11y-mobile`** — static screen-reader-label lint for Expo officer screens; fails if an interactive element has neither `accessibilityLabel` nor `accessibilityRole`. Escape hatches: `accessible={false}`, `accessibilityElementsHidden`, `importantForAccessibility`, `aria-hidden`.

## Seeded accounts

- Admin: `admin@secureops.com` / `Admin123!`
- Employee: `john.smith@secureops.com` / `Employee123!`
- Provisioned idempotently each boot by `seedDemoUsers()`. Disable with `SEED_DEMO_USERS=false`.

## Gotchas

- Run `pnpm --filter @workspace/db run push` after every schema change.
- WS clients connect to `wss://<domain>/api/ws?token=<jwt>` — proxy routes correctly.
- Orval: list hooks take `(params, { query: { queryKey } })`; mutation hooks take `{id, data}` (or nested). Codegen post-step rewrites `lib/api-zod/src/index.ts` to only re-export `./generated/api` (avoids TS2308).
- expo-notifications on web warns but doesn't crash — push registration skipped on web.
- Admin grid derived "name" cells: `derived.linkRoute` opens a route; `derived.linkTo` filters a grid. Don't point `linkTo` at its own table — it self-filters and looks like a no-op click.
- Holiday pay matches **actual** federal-holiday dates, not the bank-observed substitute (a Sat July 4 stays July 4) — WCSG pays whoever works the real day. Qualification by clock-in date in `PAYROLL_TIMEZONE`; multiplier is a fixed 1.5×.

## Pointers

- See the `pnpm-workspace` skill for monorepo structure, TS project refs, and dependency conventions.
</content>
</invoke>
