# Williams Council Security Group — SecureOps Platform

Mobile + web operations platform for Williams Council Security Group (WCSG): recruitment → onboarding → scheduling → live ops → payroll/invoicing → audit.

## Stack

pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · ws · PostgreSQL + Drizzle · Zod v4 + drizzle-zod · Expo Router v6 · expo-notifications · Orval (OpenAPI codegen) · esbuild

## Run & Operate

| Command | Purpose |
| --- | --- |
| `pnpm --filter @workspace/api-server run dev` | API server (port 8080) |
| `pnpm --filter @workspace/api-spec run codegen` | Regen API hooks + Zod from OpenAPI |
| `pnpm --filter @workspace/db run push` | Push DB schema (**re-run after every schema change**) |
| `pnpm run typecheck` / `pnpm run build` | Workspace-wide TS check / build |

### Validation gates (CI — run automatically on validation / pre-deploy)

Any failure blocks release.

- **`typecheck`** — `pnpm run typecheck`.
- **`test`** — `pnpm -r --if-present run test` (api-server Vitest, admin-portal Vitest/RTL, security-ops Vitest). Self-contained: no workflow / DB / device.
- **`security-headers`** — builds api-server then `check-security-headers` (asserts helmet CSP / CORS / HSTS / COR-P).
- **`schema-drift`** — `check-schema-drift` (`scripts/src/check-schema-drift.ts`). Introspects every pg table (and `pgEnum`) exported from `@workspace/db/schema` (via drizzle `getTableConfig` / `isPgEnum`) and asserts the live DB matches on six dimensions, reading `pg_catalog` (`format_type` + `attnotnull`, `pg_index`, `pg_enum`): **missing table**, **missing column**, **type mismatch** (e.g. `numeric(8,2)`→`numeric(10,2)` or `text`→`uuid`), **nullability mismatch** (NOT NULL added/removed), **missing index** (named `index()/uniqueIndex()` absent), **missing enum** (enum type absent, or missing a declared value). Type compare normalises whitespace so `numeric(10, 2)` (drizzle) == `numeric(10,2)` (Postgres) — no false positives. Index check matches only **named** indexes (skips `.unique()` constraints / cosmetic auto-name differences); enum/index/column checks ignore extra DB-only objects (not a release blocker). Fails fast — naming each object + the `pnpm --filter @workspace/db run push` remedy — when a push was forgotten, so a stale DB can't silently break `test`/`security-headers` later (cryptic `column ... does not exist`) or, for type/nullability/index drift, only fail at runtime in prod. Needs `DATABASE_URL` (or `OVERRIDE_DATABASE_URL`); exits 1 if the DB is unreachable.
- **`a11y`** — axe-core + Playwright/Chromium scan over key Admin Portal surfaces (Apply / Onboard / Amend forms, a DataGrid page, Import wizard). Fails on any critical/serious WCAG 2.1 A/AA violation. Self-bootstrapping: spawns api-server + admin-portal itself if not running, auto-seeds `admin@secureops.com`, tears down on exit; passes from a cold env. Distinct `prerequisite not ready:` message vs real violations (no CI false negatives). Override: `A11Y_BASE_URL`, `A11Y_ADMIN_EMAIL`, `A11Y_ADMIN_PASSWORD` (custom creds skip auto-seed). Chromium from `which chromium` or `PLAYWRIGHT_CHROMIUM`.
- **`a11y-mobile`** — static screen-reader-label lint for Expo officer screens (`scripts/src/a11y-mobile-labels.ts`). Fails if an interactive element (`TouchableOpacity` / `Pressable` / `Switch` / `TextInput` / …) has neither `accessibilityLabel` nor `accessibilityRole`. Escape hatches: `accessible={false}`, `accessibilityElementsHidden`, `importantForAccessibility`, `aria-hidden`, prop spread. Pure static analysis; scope = `OFFICER_SCREEN_GLOBS` allow-list.

### Deployment

- **Target: Reserved VM (always-on), NOT Autoscale.** The API is stateful: in-process WebSocket registry (`lib/wsManager.ts`, `/api/ws`) and in-process scheduled jobs (`lib/scheduledJobs.ts`, started once at boot with a mutex). Autoscale scale-to-zero / multi-replica causes uptime dips, dropped WS, and double-firing jobs. `artifacts/api-server/.replit-artifact/artifact.toml` declares `deploymentTarget = "vm"`; the top-level publish target must also be Reserved VM.
- **Required env**: `DATABASE_URL`, `SESSION_SECRET` (≥16 chars; production hard-fails if missing/short).
- **Optional env**: `ALLOWED_ORIGINS`, `APP_BASE_URL`, `SMTP_HOST/PORT/USER/PASS/FROM` (set all to enable outbound mail; without them endpoints return `emailSent:false` + URL for manual share), `EMERGENCY_CALL_NUMBER`, `GEOFENCE_RADIUS_MILES`, `SEED_DEMO_USERS=false`, `STRIPE_CONNECT_ENABLED`, `GEOCODING_ENABLED` (US Census geocoding of applicant addresses for the distance-from-site filter), `PAYROLL_TIMEZONE` (IANA tz used to resolve a clock-in instant to a calendar date for federal-holiday pay; default `America/Chicago`, invalid values fall back to default).

## Where things live

- **DB schema** — `lib/db/src/schema/` (users, employees, clients, sites, shifts, shiftAssignments, timeEntries, payrollEntries, invoices, incidents, licenses, chatRooms, chatMessages, applications, onboardingTokens, onboardingSubmissions, applicationAmendmentTokens, revokedTokens, auditLogs).
- **API contract** — `lib/api-spec/openapi.yaml` (source of truth) → `lib/api-client-react/src/generated/` (React Query hooks) + `lib/api-zod/src/generated/api.ts` (Zod).
- **API server** — `artifacts/api-server/src/`
  - `routes/` — auth, applications, chat, admin, storage, liveOps, payroll, shifts, incidents, audit, myPayroll, …
  - `lib/` — `wsManager` (WS at `/api/ws`), `push` (Expo), `sms` (Twilio no-op), `geofence`, `objectStorage` + `objectAcl`, `email`, `auditLog`, `scheduledJobs`, `seedDemoUsers`, `incidentPdf`, `eligibility`, `invoiceSync`.
- **Admin portal** — `artifacts/admin-portal/` (React+Vite, mounted at `/admin-portal/`)
  - `lib/tables.ts` drives the generic CRUD UI.
  - `components/{DataGrid,RowFormDialog,ImportWizard,FileUploadField,BrandHeader,RepeatingShiftDialog}.tsx`.
  - `pages/` — Apply, Onboard, AmendApplication, Applications, Onboarding, Policies, PayRun, Invitations, Shifts, AuditLog, SiteDetailPage, OfficerProfile, ResetPassword, Legal (Privacy/Terms/DataRights).
- **Mobile (Expo)** — `artifacts/security-ops/`
  - `contexts/ChatContext.tsx`, `hooks/useNotifications.ts`.
  - `app/(employee)/` (5 tabs) and `app/(admin)/` (5 tabs); `app/paystubs.tsx` (officer paystubs).
  - `components/{EmergencyButton,LiveOfficerMap,chat/}`.

## Architecture

- **Contract-first**: edit OpenAPI yaml → regen hooks + zod → server validates with zod.
- **WebSocket** at `/api/ws?token=<jwt>` — chat broadcast; JWT revocation-checked on upgrade.
- **Push**: `expo-server-sdk`; tokens in `users.expoPushToken`; web/sim degrade gracefully.
- **SMS** (additive to push): fires only when Twilio connected AND `users.phoneNumber` (E.164) AND `users.smsOptIn=true`. **Emergency contacts are never texted** — `employees.emergency_contact_phone` (+ matching cols on applications / onboarding_submissions) are call-only paper-trail fields. `sendSmsToUsers` reads `users` only; `sendSmsToPhoneNumber` guards via `isEmergencyContactPhone` and refuses + logs `error`. Rationale: no consent, no opt-out (TCPA/privacy).
- **Roles**: admin = 5 tabs (Dashboard, Personnel, Shifts, Incidents, Chat); employee = 5 tabs (Home, My Shifts, Clock, Incidents, Chat).
- **Audit log** (`lib/auditLog.ts`): records every 2xx write on privileged paths (admin/payroll/clients/sites/shifts/invoices/incidents). Sensitive keys redacted, body capped 8 KB. Read via `/admin/audit-logs`.
- **Scheduled jobs** (`lib/scheduledJobs.ts`): hourly revoked-token cleanup; hourly license-expiry reminders (30/14/7d, idempotent); hourly `lockEndedWeekInvoices`; 5-min pre-shift reminders (~2h, ~30m). Each uses an in-process mutex + atomic UPDATE-RETURNING claim; failed deliveries roll back bookkeeping for retry.

## Product

- **Client → Site → Shift hierarchy**: clients have payment terms (Net X days); sites are physical locations; shifts are posted against a site with `payRate` (officer), `billRate` (client), `requiredLicenseLevel`, `headcount`.
- **License hierarchy**: L2 unarmed → L3 armed (covers L2+L3) → L4/PPO (covers all). `maxLicenseLevel` = MAX(level) of unexpired licenses.
- **Eligibility / Support Staff** (`lib/eligibility.ts`): `employees.position` (`officer` default | `support_staff`). Shifts may require level **1** (support, no licence) in addition to 2/3/4. Effective level = `GREATEST(maxLicenseLevel, support_staff ? 1 : 0)`; higher covers lower. Helpers: `positionBaselineLevel`, `getEffectiveLevel(userId)`, `effectiveLevelSql` (needs `licensesTable` **and** `employeesTable` left-joined on `users.id`). Used by all eligibility surfaces (list/claim/admin-assign/vacancy-notify, dispatch auto-assign, availability matcher, swaps). Set position at `/admin-portal/tables/employees`.
- **Atomic shift claim** (`POST /shifts/:id/claim`): tx + `SELECT … FOR UPDATE` + headcount re-check before insert. One-tap Reserve creates `accepted`. Decline (`PUT …/assignments/:aid {status:"declined"}`) DELETES the assignment to free the slot.
- **Repeating shifts** (`POST /shifts/repeat`): expand `{startDate, untilDate, daysOfWeek[0..6], startTime/endTime}` (cap 366; overnight wrap when end ≤ start). Idempotent: skips existing shift at same site + exact `startTime`.
- **Geo clock-in** (`POST /time-entries/clock-in {lat,lng,shiftId?}`): without `shiftId`, resolves nearest site within 1 mile (haversine), stores `time_entries.siteId`; `422 No Site Nearby` if outside.
- **Live geofence**: each `/me/location` ping (~1/min while clocked in) checks officer vs active shift's site (`GEOFENCE_RADIUS_MILES`, default 0.25). First inside→outside transition → push + SMS to admins; resets on return. Skips when no coords / no active shift.
- **Open vacancies**: dashboard lists upcoming shifts where `filled<headcount`. `POST /shifts/:id/notify-vacancy` pushes qualifying officers.
- **Live map**: admin tab, Leaflet/OSM (web) or list (native), refresh 30s. Mobile pings `/me/location` every 60s while clocked in. `GET /admin/active-officers`.
- **Emergency button**: 3-second hold on employee Home. `POST /emergency` → `severity=critical` incident, push + SMS to admins, returns `callNumber` (`EMERGENCY_CALL_NUMBER` or `911`). Mobile dials via `Linking.openURL("tel:…")`.
- **Chat**: real-time named channels, persistent history, WS delivery (replaces WhatsApp).
- **Notifications**: shift assignment, vacancy, geofence breach, emergency, license expiry (30/14/7), pre-shift (2h, 30m).
- **Officer paystubs**: mobile Profile → My paystubs (`GET /me/payroll`), with YTD/lifetime totals.
- **Client incident share links**: admin mints a no-login per-incident URL at `/admin-portal/incidents/share-links`; recipients view a sanitized read-only summary + signed attachments + PDF at `/admin-portal/share/incident/:token`. Token = 32 random bytes (base64url), 30d default, revocable, view-counted. Public surface NEVER returns adminNotes, officer email/phone, or full name (reduced to "F. Last"); PDF builder mirrors via `{ redactForPublicShare: true }`. Rate limits: `tokenLookupLimiter` (60/5min/IP) + `publicShareExpensiveLimiter` (15/15min/IP) on PDF. Minting fails closed (503) unless `APP_BASE_URL`/`REPLIT_DOMAINS` set.

### Invoicing

- **Auto-populated + idempotent**: every time-entry approval (`POST /time-entries/:id/approve {decision:"approved"}`) fires `lib/invoiceSync.upsertWeeklyInvoiceForTimeEntry` — finds-or-creates a `draft` invoice keyed on (`siteId`, `periodStart`=Monday 00:00 UTC) and rebuilds line items from all currently-approved entries that ISO week. Rejection re-syncs (removes line, prunes empty draft). Manual `POST /invoices/generate {siteId, weekStart}` delegates to the same upsert.
  - Hours = each entry's `hoursWorked` (open / 0-hour skipped). Rate = `shifts.billRate` → `sites.defaultBillRate` → refuse (400). Includes ad-hoc geo clock-ins. Line items grouped per (officer, rate). Due = today + `clients.paymentTermsDays`.
  - **Federal-holiday billing (1.5×)**: hours whose clock-in date (in `PAYROLL_TIMEZONE`) lands on a US federal holiday are billed at time-and-a-half (`billRate × 1.5`, rounded to cents) and split into their own line item — description `… — Holiday (<Holiday Name>, 1.5×)`. Applies to officer AND subcontractor lines. Holiday calendar in `lib/holidays.ts`.
- **Lifecycle / mutability**: syncable iff `status='draft' AND locked_at IS NULL AND auto_synced=true`. Out-of-sync events:
  - **Admin edit** of billable fields (via `PUT /invoices/:id` or generic `PUT /admin/tables/invoices/:id`) flips `auto_synced=false` — late approvals become the admin's responsibility (logged warning).
  - **Week end**: hourly `lockEndedWeekInvoices` stamps `locked_at` on drafts whose `period_end < today (UTC)`. Late approval for a locked week creates a **new adjustment draft** — enabled by partial unique index `invoices_active_auto_draft_per_week_idx` on `(site_id, period_start) WHERE status='draft' AND locked_at IS NULL AND auto_synced=true`.
  - Race-safe: on `23505` the loser re-selects the winner and applies its line items as UPDATE (idempotent).

### Payroll

- **Rate priority**: `time_entries.pay_rate_override` (admin) → `shifts.payRate` → `employees.hourlyRate` → $0 (warning). Backfill override via Payroll Board "Apply pay rate" (`POST /payroll/board/apply-rate {timeEntryIds[], rate, onlyZeroRate?}`, admin-only, audited). Refuses `processed`/`paid` buckets. `onlyZeroRate=true` (default) skips non-zero rates. Pay Run re-runs `computeBoardBuckets` at process time.
- **Federal-holiday pay (1.5×)**: after the base rate is resolved, hours whose clock-in date (in `PAYROLL_TIMEZONE`) lands on a US federal holiday are paid at time-and-a-half (`effectiveRate = baseRate × 1.5`). Applies in both `/payroll/generate` and `computeBoardBuckets` (board gross + per-entry detail carry the effective rate; each entry exposes a `holiday: string|null` name). The Payroll Board shows an amber "Holiday 1.5×" badge. Whole-entry qualification by clock-in date — no midnight split. Calendar + policy in `lib/holidays.ts` (`HOLIDAY_PAY_MULTIPLIER`, `getFederalHolidayName`); 11 actual (not bank-observed) federal holiday dates, computed + memoized per year.
- **Pay Run** (`/admin-portal/payroll/pay-run`): pending → processed (after CSV export) → paid.
  - `POST /payroll/pay-run/preview {ids[]}` → rows + per-row warnings (missing bank/routing/name, no DD consent, zero/negative net). Warnings + already-paid excluded from CSV.
  - `POST /payroll/pay-run/export-csv {ids[], batchReference?}` → `wcsg-payroll-<batch>.csv`; atomically marks payable rows `processed`, `paidMethod='ach_csv'`, `paymentReference=<batch>`, `paidBy=admin`. Idempotent.
  - `POST /payroll/pay-run/mark-paid {ids[], paymentReference?, method?}` → `paid` (default method `manual`).
  - `POST /payroll/pay-run/stripe` → 501 unless `STRIPE_CONNECT_ENABLED=true` (schema has `stripeTransferId`; flip flag + `STRIPE_SECRET_KEY` + employee `stripeAccountId` + implement `stripe.transfers.create()`).
  - Bank source: `employees.bankAccountName / bankAccountNumber / bankBsb` (UK column names, US labels); `directDepositConsent` must be true. `payroll_entries` cols: `paidBy`, `paidMethod` (`manual|ach_csv|stripe`), `paymentReference`, `stripeTransferId`; status enum includes `failed`.

## HR pipeline (recruitment → onboarding)

- **Public application** (`/admin-portal/apply`) — multi-step (personal, right-to-work, TX license + experience, references + photo/CV/certs, availability, review). Files via presigned URL (`POST /api/storage/uploads/request-url` → PUT to GCS). Submits to `POST /api/applications` (no auth, rate-limited).
- **Admin Applications** (`/admin-portal/hr/applications`) — filter/search, review dialog, under-review / reject / approve, batch "Request more info".
- **Approve** creates `User` (role=`employee`, status=`pending`, temp pw) + `Employee` + `License` (if TX info), invalidates prior tokens, mints 14-day single-use `OnboardingToken`. Returns `onboardingUrl`, `tempPassword`, `emailSent`. Email-conflict guard: re-provisions existing user only if `role==='employee'` AND status `pending`/`inactive`; else 409.
- **Public onboarding** (`/admin-portal/onboard/:token`) — prefilled; submits bank/tax/W-2-or-pay-stub/emergency contact/uniform sizes/TX-license+passport docs/DD consent + signature + 4 acknowledgements. Upserts submission, copies bank+emergency to `employees`, sets user `active`, consumes token, pushes admins. (DB cols keep UK names — `sia_license_*`, `ni_number*`, `p45_doc_key` — UI labels are TX/US.)
- **Admin Onboarding** (`/admin-portal/hr/onboarding`) — pending vs completed, detail dialog, "Resend onboarding link".
- **Request more info** (per-app or batch): `POST /admin/applications/:id/request-info {fields[], note?}` mints 14-day single-use `application_amendment_tokens`, sets status `info_requested`, emails `/admin-portal/amend/:token`. `POST /applications/amend/:token` enforces all requested fields filled, applies atomically (`SELECT … FOR UPDATE`), bumps to `under_review`. Batch sends parallel (cap 4).

## Invitations (bulk temp passwords + invite emails)

- Page: `/admin-portal/hr/invitations`. Two-phase. Admins NEVER targeted.
- **Generate** — `POST /admin/users/bulk-temp-passwords {scope:"all_non_admin"|"by_ids", userIds?, force?}`: 10-char pw (avoids 0/O/1/I/l), bcrypt → `password_hash`, plaintext → `temp_password_plain`, sets `must_change_password=true`. `force=false` skips users with unsent temp pw.
- **Send** — `POST /admin/users/bulk-invite {userIds[]}`: emails sign-in URL + email + temp pw, then clears `temp_password_plain`, stamps `invited_at`.
- `GET /admin/users/invitations` returns `tempPasswordPlain` (admin-only). Generic `/admin/tables/users` strips `passwordHash` + `tempPasswordPlain`. Sign-in URL from `APP_BASE_URL` (preferred) or `REPLIT_DOMAINS`.

## Security baseline

- **CORS** locked to `ALLOWED_ORIGINS ∪ REPLIT_DOMAINS`; no-Origin (native/curl) allowed.
- **Helmet** with `crossOriginResourcePolicy: cross-origin` (signed downloads embed). CSP in production only.
- **Rate limiters** (`middlewares/rateLimit.ts`): login (10/15min/IP+email), forgot-password (5/hr/IP+email), public-application (5/hr/IP), token-lookup (60/5min/IP), emergency (5/min/user), upload-URL (per-IP cap).
- **JWT revocation** (both checked in `requireAuth` AND on `/api/ws` upgrade): (1) `users.tokens_valid_after` watermark — bumped by `POST /auth/logout-all` (self) or `POST /admin/users/:id/revoke-sessions`; tokens with `iat<watermark` rejected. (2) `revoked_tokens(jti)` — written by `POST /auth/logout`. Hourly cleanup of expired rows.
- **System status**: `GET /admin/system/status` (admin) → booleans for SMTP / SESSION_SECRET / base-URL / CORS. Admin shell shows amber banner when degraded; boot logs `error` per missing prod requirement.
- **Public legal pages**: `/admin-portal/{privacy,terms,data-rights}`, linked from Apply, admin Login, mobile login.
- **DB indexes** on hot paths: `shifts(siteId,startTime)`, `shiftAssignments(shiftId,status)`, `timeEntries(employeeId,clockInTime)`, `chatMessages(roomId,createdAt)`, `incidents(employeeId,occurredAt)`, `revokedTokens(userId)`, `revokedTokens(expiresAt)`.

## Seeded accounts

- Admin: `admin@secureops.com` / `Admin123!`
- Employee: `john.smith@secureops.com` / `Employee123!`
- Provisioned idempotently each boot by `seedDemoUsers()`. Disable with `SEED_DEMO_USERS=false`.

## User preferences

- Brand: deep navy `#080c18`, rich gold `#c9a84c`, warm cream `#f0e6c8`
- Company: Williams Council Security Group (WCSG)
- Currency: USD ($)

## Gotchas

- `pnpm --filter @workspace/db run push` after every schema change.
- WS clients: `wss://<domain>/api/ws?token=<jwt>` — proxy routes correctly.
- Orval: list hooks take `(params, { query: { queryKey } })`; mutation hooks take `{id, data}` (or nested `{id, assignmentId, data}`). Codegen post-step rewrites `lib/api-zod/src/index.ts` to only re-export `./generated/api` (avoids TS2308).
- expo-notifications on web warns but doesn't crash — push registration skipped on web.
- Admin grid derived "name" cells: `derived.linkRoute` opens a route (e.g. employee name → `/personnel/:userId`); `derived.linkTo` filters a grid. Don't point `linkTo` back at its own table — it self-filters and looks like a no-op click.
- Holiday pay (`lib/holidays.ts`) matches **actual** federal-holiday dates, NOT the bank-observed substitute (a Sat July 4 stays July 4, not observed-Friday) — WCSG pays whoever works the real day. Qualification is by clock-in date in `PAYROLL_TIMEZONE`, so a night shift starting 8pm CT on the holiday counts even though it's already next-day UTC. Multiplier is a fixed 1.5× (not configurable).

## Pointers

- See the `pnpm-workspace` skill for monorepo structure, TS project refs, dependency conventions.
