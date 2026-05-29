# Williams Council Security Group — SecureOps Platform

Mobile + web operations platform for Williams Council Security Group (WCSG): recruitment → onboarding → scheduling → live ops → payroll/invoicing → audit.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080)
- `pnpm run typecheck` / `pnpm run build` — workspace-wide TS check / build
- `pnpm --filter @workspace/api-spec run codegen` — regen API hooks + Zod from OpenAPI
- `pnpm --filter @workspace/db run push` — push DB schema (re-run after every schema change)
- `pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/scripts run check-security-headers` — pre-deploy: assert helmet CSP / CORS / HSTS / COR-P
- `pnpm --filter @workspace/scripts run a11y` — accessibility regression scan (axe-core + Playwright/Chromium) over the Admin Portal's key surfaces (public Apply / Onboard / Amend forms, a DataGrid table page, the Import wizard dialog). Fails on any critical/serious WCAG 2.1 A/AA violation. Requires the admin-portal + api-server workflows running and a seeded admin account; mints its own short-lived onboarding/amendment tokens. Override with `A11Y_BASE_URL`, `A11Y_ADMIN_EMAIL`, `A11Y_ADMIN_PASSWORD`. Chromium is resolved from the Nix system binary (`which chromium`) or `PLAYWRIGHT_CHROMIUM`.
- **Deployment target: Reserved VM (always-on), NOT Autoscale.** This API is stateful: in-process WebSocket registry (`lib/wsManager.ts`, chat + live map at `/api/ws`) and in-process scheduled jobs (`lib/scheduledJobs.ts`, started once at boot via `startScheduledJobs()` with an in-process mutex). Autoscale's scale-to-zero/cold-starts and multi-replica behavior cause intermittent uptime dips, dropped WS connections, and unreliable/double-firing background jobs. `artifacts/api-server/.replit-artifact/artifact.toml` already declares `deploymentTarget = "vm"`; the top-level publish target must also be Reserved VM (selected in the Publish pane).
- Required env: `DATABASE_URL`, `SESSION_SECRET` (≥16 chars; production hard-fails if missing/short)
- Optional env: `ALLOWED_ORIGINS`, `APP_BASE_URL`, `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` (set all to enable outbound mail — onboarding-on-approve, password reset, invitations, request-info, license/training reminders; without them, endpoints return `emailSent:false` + URL so admin can share manually), `EMERGENCY_CALL_NUMBER`, `GEOFENCE_RADIUS_MILES`, `SEED_DEMO_USERS=false`, `STRIPE_CONNECT_ENABLED`, `GEOCODING_ENABLED` (set `true` to enable best-effort US Census geocoding of applicant home addresses — required for the admin distance-from-site applicant filter; sends street/city/state/zip to `geocoding.geo.census.gov`)

## Stack

- pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · ws · PostgreSQL + Drizzle · Zod v4 + drizzle-zod · Expo Router v6 · expo-notifications · Orval (OpenAPI codegen) · esbuild

## Where things live

- **DB schema** — `lib/db/src/schema/` (users, employees, clients, sites, shifts, shiftAssignments, timeEntries, payrollEntries, invoices, incidents, licenses, chatRooms, chatMessages, applications, onboardingTokens, onboardingSubmissions, applicationAmendmentTokens, revokedTokens, auditLogs)
- **API contract** — `lib/api-spec/openapi.yaml` (source of truth) → `lib/api-client-react/src/generated/` (React Query hooks) + `lib/api-zod/src/generated/api.ts` (Zod)
- **API server** — `artifacts/api-server/src/`
  - `routes/` — `auth, applications, chat, admin, storage, liveOps, payroll, shifts, incidents, audit, myPayroll, ...`
  - `lib/` — `wsManager` (WS at `/api/ws`), `push` (Expo), `sms` (Twilio no-op), `geofence`, `objectStorage` + `objectAcl`, `email`, `auditLog`, `scheduledJobs`, `seedDemoUsers`, `incidentPdf`
- **Admin portal** — `artifacts/admin-portal/` (React+Vite, mounted at `/admin-portal/`)
  - `lib/tables.ts` drives the generic CRUD UI
  - `components/{DataGrid,RowFormDialog,ImportWizard,FileUploadField,BrandHeader,RepeatingShiftDialog}.tsx`
  - `pages/` — `Apply, Onboard, AmendApplication, Applications, Onboarding, Policies, PayRun, Invitations, Shifts, AuditLog, SiteDetailPage, ResetPassword, Legal (Privacy/Terms/DataRights)`
- **Mobile (Expo)** — `artifacts/security-ops/`
  - `contexts/ChatContext.tsx`, `hooks/useNotifications.ts`
  - `app/(employee)/` (5 tabs) and `app/(admin)/` (5 tabs)
  - `app/paystubs.tsx` — officer paystubs (linked from profile)
  - `components/{EmergencyButton,LiveOfficerMap,chat/}`

## Architecture

- **Contract-first**: edit OpenAPI yaml, regen hooks + zod, server uses zod for validation.
- **WebSocket** at `/api/ws?token=<jwt>` — chat broadcast, JWT also revocation-checked on upgrade.
- **Push**: `expo-server-sdk`; tokens in `users.expoPushToken`; web/sim degrade gracefully.
- **SMS**: additive to push; only fires when Twilio integration connected AND `users.phoneNumber` (E.164) AND `users.smsOptIn=true`. **Emergency contacts are never texted** — `employees.emergency_contact_phone` (and the matching columns on `applications` / `onboarding_submissions`) are call-only paper-trail fields. `sendSmsToUsers` reads from `users` only, so the path is structurally safe; `sendSmsToPhoneNumber` has a runtime guard (`isEmergencyContactPhone`) that refuses any number matching an emergency-contact-of-record and logs an `error`. Rationale: those people never consented and have no opt-out (TCPA/privacy).
- **Roles**: admin = 5 tabs (Dashboard, Personnel, Shifts, Incidents, Chat); employee = 5 tabs (Home, My Shifts, Clock, Incidents, Chat).
- **Audit log**: `lib/auditLog.ts` records every 2xx write on privileged paths (admin/payroll/clients/sites/shifts/invoices/incidents). Sensitive keys redacted, body capped 8 KB. Read via `/admin/audit-logs`.
- **Scheduled jobs** (`lib/scheduledJobs.ts`): hourly cleanup of revoked tokens; hourly license-expiry reminders (30/14/7 days, idempotent via `licenses.last_reminder_for_expiry` + `last_reminder_tier`); 5-min pre-shift reminders (~2h, ~30m). Each job uses an in-process mutex + atomic UPDATE-RETURNING claim; failed deliveries roll back bookkeeping for retry.

## Product

- **Client → Site hierarchy**: clients have payment terms (Net X days), sites are physical locations, shifts are posted against a site with `payRate` (officer) + `billRate` (client) + `requiredLicenseLevel` (2/3/4) + `headcount`.
- **License hierarchy**: L2 unarmed → L3 armed (covers L2+L3) → L4/PPO (covers all). `maxLicenseLevel` = MAX(level) of unexpired licenses.
- **Support Staff / capability-level eligibility**: `employees.position` (`officer` default | `support_staff`). Shifts can require level **1** ("Support / no licence required") in addition to 2/3/4. An officer's **effective level** = `GREATEST(maxLicenseLevel, position==='support_staff' ? 1 : 0)`; higher levels cover lower, so licensed officers also qualify for support shifts while non-licensed support staff qualify only for level-1 shifts. Shared helper `artifacts/api-server/src/lib/eligibility.ts` exports `positionBaselineLevel`, `getEffectiveLevel(userId)` (single-officer), and `effectiveLevelSql` (grouped-query fragment; requires `licensesTable` **and** `employeesTable` left-joined on `users.id` — `licenses.employee_id` and `employees.user_id` both reference `users.id`). All eligibility surfaces (shift list/claim/admin-assign/vacancy-notify, dispatch auto-assign, availability matcher, shift swaps) use this helper. Set position from `/admin-portal/tables/employees` ("Position").
- **Payroll Board rate priority**: `time_entries.pay_rate_override` (admin-set) -> `shifts.payRate` -> `employees.hourlyRate` -> $0 (warning). Admin can backfill the override from the Payroll Board "Apply pay rate" toolbar action (`POST /payroll/board/apply-rate {timeEntryIds[], rate, onlyZeroRate?}`, admin-only, audit-logged as `payroll.board_apply_rate`). Refuses entries whose payroll bucket is already `processed`/`paid` (those numbers have shipped to the bank). `onlyZeroRate=true` (default) skips entries with an existing non-zero effective rate so wide selections are safe; uncheck to force-overwrite. Pay Run snapshot picks up the new rate automatically because it re-runs `computeBoardBuckets` at process time.
- **Atomic shift claim** (`POST /shifts/:id/claim`): tx + `SELECT … FOR UPDATE` + headcount re-check before insert. Officer one-tap Reserve creates `accepted` directly. Decline (`PUT …/assignments/:aid {status:"declined"}`) DELETES the assignment so the slot is freed.
- **Repeating shifts** (`POST /shifts/repeat`): expand `{startDate, untilDate, daysOfWeek[0..6], startTime/endTime "HH:MM"}` (cap 366; overnight wrap when end ≤ start), `isRepeat=true`, pattern in `repeatPattern`. Idempotent: skips existing shifts at same site + exact `startTime`.
- **Geo clock-in** (`POST /time-entries/clock-in {lat,lng,shiftId?}`): when `shiftId` omitted, resolves nearest site within 1 mile (haversine over `sites.locationLat/Lng`), stores `time_entries.siteId`. Returns `422 No Site Nearby` if outside radius.
- **Live geofence**: every `/me/location` ping (≈1/min while clocked in) evaluates officer vs active shift's site (radius `GEOFENCE_RADIUS_MILES`, default 0.25 mi). On first inside→outside transition, push + SMS to admins. Resets on return. Skips silently when site has no coords or no active shift.
- **Invoice generation — auto-populated + idempotent** (May 2026): every time-entry approval (`POST /time-entries/:id/approve {decision:"approved"}`) fires `lib/invoiceSync.upsertWeeklyInvoiceForTimeEntry`, which finds-or-creates a `draft` invoice keyed on (`siteId`, `periodStart`=Monday 00:00 UTC of `clockInTime`) and rebuilds its line items from every currently-approved entry in that ISO week. Rejection re-syncs too: removes the line and prunes the draft if it becomes empty. Manual `POST /invoices/generate {siteId, weekStart}` delegates to the same upsert (same priced-entries math, same site→bill-rate resolution, same 404/400 error contract). Hours = each entry's actual `hoursWorked` (open / 0-hour entries skipped). Rate = `shifts.billRate` -> `sites.defaultBillRate` -> refuse (400 with legacy "no bill rate on file" wording). Includes ad-hoc geo clock-ins via `or(shift.siteId=siteId, time_entries.siteId=siteId)`. Line items grouped per (officer, rate). Due date = today + `clients.paymentTermsDays`. Site bill rate editable from `/admin-portal/tables/sites` ("Bill Rate ($/hr)").
- **Invoice lifecycle + mutability**: an invoice is "syncable" iff `status='draft' AND locked_at IS NULL AND auto_synced=true`. Two events take a draft out of sync:
  - **Admin edit** of billable fields (`lineItems` / `subtotal` / `totalAmount` / `taxAmount`) via dedicated `PUT /invoices/:id` OR generic `PUT /admin/tables/invoices/:id` flips `auto_synced=false` — late approvals for the same week are then the admin's responsibility (logged as a warning).
  - **Week end**: hourly `lockEndedWeekInvoices` scheduled job stamps `locked_at=now()` on every draft whose `period_end < today (UTC)`. A late approval for an already-locked week creates a **new adjustment draft** for the same (site, week) instead of mutating the locked row — guaranteed by the partial unique index `invoices_active_auto_draft_per_week_idx` on `(site_id, period_start) WHERE status='draft' AND locked_at IS NULL AND auto_synced=true`, which permits the locked-original + fresh-adjustment combo.
  - Race-safe upsert: concurrent approvals can't produce duplicate auto-drafts. On unique-violation (`23505`) the loser re-selects the winner and applies its line items as an UPDATE (latest-arriving tick wins; idempotent).
- **Open vacancies**: admin dashboard lists upcoming shifts where `filled<headcount`. `POST /shifts/:id/notify-vacancy` (admin) pushes qualifying officers (`maxLicenseLevel ≥ requiredLicenseLevel`).
- **Live map**: admin Live Map tab, Leaflet/OSM (web) or list (native), refresh 30s. Mobile pings `/me/location` every 60s while clocked in. `GET /admin/active-officers`.
- **Emergency button**: red 3-second hold on employee Home (visual fill bar). `POST /emergency` creates `severity=critical` incident, push "🚨 EMERGENCY ALERT" + SMS to admins, returns `callNumber` (`EMERGENCY_CALL_NUMBER` or `911`). Mobile dials via `Linking.openURL("tel:…")`.
- **Chat**: real-time named channels, persistent history, WS delivery, replaces WhatsApp.
- **Notifications recap**: shift assignment, vacancy, geofence breach, emergency, license expiry (30/14/7), pre-shift (2h, 30m).
- **Audit + Officer paystubs** (May 2026 wave 1): admins see every privileged write at `/admin-portal/audit-log`; officers see their pay history + YTD/lifetime totals at mobile Profile → My paystubs (`GET /me/payroll`).
- **Client incident share links** (May 2026 wave 3.2): admin mints a no-login per-incident URL at `/admin-portal/incidents/share-links`. Recipients view a sanitized read-only summary + signed attachments + PDF at `/admin-portal/share/incident/:token` — no portal account required. Token = 32 random bytes (base64url), default 30d expiry, instantly revocable, view-counted. Public surface NEVER returns adminNotes, officer email/phone, or full officer name (reduced to "F. Last"). PDF builder accepts `{ redactForPublicShare: true }` to strip the same fields. Two rate limits: `tokenLookupLimiter` (60/5min/IP) on both endpoints, plus `publicShareExpensiveLimiter` (15/15min/IP) on the PDF render. Share-URL minting fails closed (503) unless `APP_BASE_URL` or `REPLIT_DOMAINS` is configured (no Host-header fallback). Routes: `POST /admin/incidents/:id/share`, `GET /admin/incident-shares?incidentId=…`, `POST /admin/incident-shares/:id/revoke`, `GET /public/incident-shares/:token`, `GET /public/incident-shares/:token/pdf`.

## Pay Run (payroll execution)

- Page: `/admin-portal/payroll/pay-run`. Three states: pending → processed (after CSV export) → paid.
- `POST /payroll/pay-run/preview {ids[]}` → rows + per-row warnings (missing bank acct/routing/name, no direct-deposit consent, zero/negative net) + counts. Warnings + already-paid excluded from CSV.
- `POST /payroll/pay-run/export-csv {ids[], batchReference?}` → downloads `wcsg-payroll-<batch>.csv` (Employee Name, Account Name, Routing Number, Account Number, Amount USD, Pay Period Start/End, Site, Reference, Memo). Atomically marks payable rows `processed`, `paidMethod='ach_csv'`, `paymentReference=<batch>`, `paidBy=admin`. Idempotent.
- `POST /payroll/pay-run/mark-paid {ids[], paymentReference?, method?}` → `paid` after bank confirms. Default method `manual`.
- `POST /payroll/pay-run/stripe` → 501 unless `STRIPE_CONNECT_ENABLED=true`. Schema has `stripeTransferId` ready; flip flag + add `STRIPE_SECRET_KEY` + populate employee `stripeAccountId` + implement `stripe.transfers.create()`.
- Bank source: `employees.bankAccountName / bankAccountNumber / bankBsb` (UK column names, US labels). `directDepositConsent` must be true.
- `payroll_entries` extra cols: `paidBy`, `paidMethod` (`manual|ach_csv|stripe`), `paymentReference`, `stripeTransferId`. Status enum includes `failed`.

## HR pipeline (recruitment → onboarding)

- **Public application** at `/admin-portal/apply` — multi-step (personal, right-to-work, TX security license + experience, references + photo/CV/training certs, weekly availability, review). Files via presigned URL → `POST /api/storage/uploads/request-url` → PUT to GCS. Submits to `POST /api/applications` (no auth, rate-limited).
- **Admin Applications** at `/admin-portal/hr/applications` — filter/search, review dialog, mark under review / reject / approve. Row checkboxes + sticky toolbar drive batch "Request more info from N".
- **Approve** creates `User` (role=`employee`, status=`pending`, random temp pw) + `Employee` + `License` (if TX info), invalidates prior tokens, mints 14-day single-use `OnboardingToken`, links via `createdEmployeeId`. Returns `onboardingUrl`, `tempPassword`, `emailSent`. Email-conflict guard: only re-provisions existing user if `role==='employee'` AND status `pending`/`inactive`; else 409.
- **Public onboarding** at `/admin-portal/onboard/:token` — prefilled (name/email/phone/SSN/TX-license), submits bank/tax/W-2-or-pay-stub/emergency contact/uniform sizes/TX-license+passport docs/direct-deposit consent + signature/4 acknowledgements (Drug-Free, Uniform, NDA, Contract). Upserts submission, copies bank+emergency to `employees`, sets user `active`, consumes token, pushes admins. (DB cols keep UK names — `sia_license_*`, `ni_number*`, `p45_doc_key` — UI labels are TX/US.)
- **Admin Onboarding** at `/admin-portal/hr/onboarding` — pending vs completed, detail dialog, "Resend onboarding link" mints fresh token.
- **Request more info** (per-app or batch): `POST /admin/applications/:id/request-info {fields[], note?}` mints 14-day single-use `application_amendment_tokens`, sets app status `info_requested`, emails link to `/admin-portal/amend/:token`. `POST /applications/amend/:token` enforces every requested field is filled, applies updates atomically (`SELECT … FOR UPDATE` on token), bumps status to `under_review`. Batch UI sends in parallel (cap 4 concurrent), per-row try/catch.
- Email: SMTP (`SMTP_HOST/PORT/USER/PASS`, optional `SMTP_FROM`); otherwise endpoints return `emailSent:false` + the URL so admin can share manually.

## Invitations (bulk temp passwords + invite emails)

- Page: `/admin-portal/hr/invitations`. Two-phase.
- **Generate**: `POST /admin/users/bulk-temp-passwords {scope:"all_non_admin"|"by_ids", userIds?, force?}` — 10-char password (avoids 0/O/1/I/l), bcrypt → `users.password_hash`, plaintext → `users.temp_password_plain`, sets `temp_password_set_at`, `must_change_password=true`, clears `invited_at`. `force=false` skips users with unsent temp pw. Admins NEVER targeted.
- **Send**: `POST /admin/users/bulk-invite {userIds[]}` — emails sign-in URL + email + temp pw, then clears `temp_password_plain` + stamps `invited_at`.
- `GET /admin/users/invitations` returns rows incl. `tempPasswordPlain` (admin-only). Generic `/admin/tables/users` strips `passwordHash` + `tempPasswordPlain`.
- Sign-in URL built from `APP_BASE_URL` (preferred) or `REPLIT_DOMAINS`.

## Security baseline (May 2026 launch pack)

- **CORS** locked to `ALLOWED_ORIGINS ∪ REPLIT_DOMAINS`; no-Origin (native/curl) allowed.
- **Helmet** with `crossOriginResourcePolicy: cross-origin` (so signed object downloads embed). CSP enabled in production only.
- **Rate limiters** (`middlewares/rateLimit.ts`): login (10/15min/IP+email), forgot-password (5/hr/IP+email), public-application (5/hr/IP), token-lookup (60/5min/IP), emergency (5/min/user), upload-URL endpoints (per-IP cap).
- **JWT revocation**: two layers, both checked in `requireAuth` AND on `/api/ws` upgrade. (1) `users.tokens_valid_after` watermark — bumped by `POST /auth/logout-all` (self) or `POST /admin/users/:id/revoke-sessions`; tokens with `iat<watermark` rejected. (2) `revoked_tokens(jti)` — written by `POST /auth/logout`. Hourly cleanup of expired rows.
- **System status**: `GET /admin/system/status` (admin) returns booleans for SMTP / SESSION_SECRET / base-URL / CORS. Admin shell renders amber banner on degraded config. Boot logs `error` for each missing prod requirement.
- **Public legal pages**: `/admin-portal/{privacy,terms,data-rights}` linked from Apply, admin Login, mobile login.
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
- Orval: list hooks take `(params, { query: { queryKey } })`; mutation hooks take `{id, data}` (or `{id, assignmentId, data}` nested). Codegen post-step rewrites `lib/api-zod/src/index.ts` to only re-export from `./generated/api` (avoids TS2308 duplicate export).
- expo-notifications on web warns but doesn't crash — push registration is skipped on web.

## Pointers

- See the `pnpm-workspace` skill for monorepo structure, TS project refs, dependency conventions.
