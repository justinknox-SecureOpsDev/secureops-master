# Williams Council Security Group — SecureOps Platform

A full-stack mobile operations platform for Williams Council Security Group (WCSG), covering recruitment through operational control for private security officers.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — JWT signing key (≥16 chars; production hard-fails at boot if missing/short)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + WebSocket (ws package) for real-time chat
- DB: PostgreSQL + Drizzle ORM (11 tables; shifts have `requiredLicenseLevel` 2/3/4 + `headcount`, licenses have `level`)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Mobile: Expo Router v6, React Native, expo-notifications
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/db/src/schema/` — DB schema (users, employees, shifts, shiftAssignments, timeEntries, payrollEntries, invoices, incidents, licenses, chatRooms, chatMessages)
- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/api-zod/src/generated/api.ts` — generated Zod validation schemas
- `artifacts/api-server/src/` — Express 5 API server
- `artifacts/api-server/src/lib/wsManager.ts` — WebSocket server manager
- `artifacts/api-server/src/lib/push.ts` — Expo push notification sender
- `artifacts/api-server/src/routes/chat.ts` — Chat REST endpoints
- `artifacts/api-server/src/routes/admin.ts` — Generic admin CRUD (`/admin/tables`, `/admin/tables/:table[/:id]`, `/admin/import/:table`); admin-only via `requireAdmin`
- `artifacts/admin-portal/` — React+Vite browser admin portal at `/admin-portal/` (sidebar of all 11 tables, generic grid, Excel/CSV import)
- `artifacts/admin-portal/src/lib/tables.ts` — TABLE descriptors that drive the entire generic UI (fields, FKs, options, importable flag)
- `artifacts/admin-portal/src/components/{DataGrid,RowFormDialog,ImportWizard,FileUploadField,BrandHeader}.tsx`
- `artifacts/admin-portal/src/pages/{Apply,Onboard,Applications,Onboarding}.tsx` — HR public + admin pages
- `artifacts/admin-portal/src/lib/upload.ts` — client helper: presigned-URL upload via `/storage/uploads/request-url`
- `artifacts/api-server/src/routes/applications.ts` — public application submit, admin review/approve, public onboarding GET/POST, admin onboarding list/detail/resend
- `artifacts/api-server/src/routes/storage.ts` + `src/lib/{objectStorage,objectAcl}.ts` — App Storage upload URL + file serving (uploads bind path to caller's userId via `/objects/uploads/u/<userId>/<uuid>` when authenticated; incident attachments + `/me/storage/sign` enforce that prefix so officers can only sign their own files)
- `lib/db/src/schema/{applications,onboardingTokens,onboardingSubmissions}.ts` — HR pipeline tables
- `artifacts/security-ops/` — Expo mobile app
- `artifacts/security-ops/contexts/ChatContext.tsx` — WebSocket chat context
- `artifacts/security-ops/components/chat/` — Chat UI components
- `artifacts/security-ops/hooks/useNotifications.ts` — Push notification registration
- `artifacts/api-server/src/routes/liveOps.ts` — Live location, active officers, emergency endpoints
- `artifacts/security-ops/components/EmergencyButton.tsx` — Panic button on employee home
- `artifacts/security-ops/components/LiveOfficerMap.tsx` — Leaflet map (web) / list (native)
- `artifacts/security-ops/app/(admin)/live-map.tsx` — Admin Live Map tab

## Architecture decisions

- **Contract-first API**: OpenAPI YAML is the source of truth; hooks and Zod schemas are generated from it.
- **WebSocket at `/api/ws`**: Same port as HTTP server; JWT token passed as query param for auth; broadcasts chat messages to all connected clients.
- **Expo Push API**: Uses `expo-server-sdk` on the server to send notifications; tokens stored in users table; degrades gracefully on web/simulator.
- **Chat General room**: Auto-created on first `/chat/rooms` GET; admins can create additional channels.
- **Role-based nav**: Admin gets 5 tabs (Dashboard, Personnel, Shifts, Incidents, Chat); Employee gets 5 tabs (Home, My Shifts, Clock, Incidents, Chat).

## Product

- **Client → Site hierarchy**: Clients have payment terms (Net X days). Each client has Sites (physical locations). Shifts are posted against a Site with per-shift `payRate` (officer) and `billRate` (client). Site replaces the old free-text `clientName`/`location`.
- **Admin**: Manage clients (with payment terms) + sites; post shifts on sites with bill/pay rates + required licence level + headcount; approve time entries; generate weekly payroll per (employee × site × week) from approved hours; generate weekly invoices per (client × site × week) at billRate × approved hours, **execute payroll via Pay Run** (bulk select → ACH CSV export or mark-paid; Stripe Connect scaffolded behind flag); mark payroll/invoices paid manually; review incidents; track licences; broadcast via team chat.
- **Employee**: See highest current clearance on profile; browse "Available" shifts they qualify for; **one-tap Reserve** books the shift immediately (`POST /shifts/:id/claim` inserts an `accepted` assignment); officer can later Decline to release the slot; GPS clock in/out (entries start `pending` admin approval); report incidents (with optional camera/library photo attachments uploaded to App Storage); team chat.
- **Geo clock-in (no shift required)**: `POST /time-entries/clock-in` accepts `{lat,lng}` with optional `shiftId`. When `shiftId` is omitted, the server resolves the nearest Site within **1 mile** (haversine over `sites.locationLat/Lng`) and stores `time_entries.siteId` (column added; `shiftId` is now nullable). Returns `{geoResolved:{siteName,distanceMiles}}` on success or `422 No Site Nearby` if outside radius. Mobile clock screen surfaces both. Time-entry list filtering by `siteId` uses `coalesce(timeEntries.siteId, shifts.siteId)`.
- **Licence hierarchy**: L2 unarmed (lowest) → L3 armed (covers L2+L3) → L4/PPO (covers all). `maxLicenseLevel` = MAX(level) of unexpired licences.
- **Atomic shift claim**: `POST /shifts/{id}/claim` runs inside a transaction that locks the shift row (`SELECT … FOR UPDATE`) and re-counts assignments before inserting, preventing races from overfilling. Creates an `accepted` assignment (one-tap Reserve = booked) and sends "✅ Shift Reserved" Expo push. Admin "+" (`POST /shifts/{id}/assignments`) likewise creates `accepted` directly.
- **Currency**: USD ($) throughout admin payroll/invoice screens.
- **Chat**: Replaces WhatsApp — real-time team messaging with named channels, persistent message history, WebSocket delivery.
- **Notifications**: Push alerts on shift assignment (iOS/Android); web degrades gracefully.
- **Repeating shifts**: Admin Shifts page has a "Repeating Shift" button next to "Add Shift" — opens a dialog to pick site, days-of-week (Mon–Sun chips), date range (from/until), start/end times, pay/bill rates, min licence, headcount, notes. `POST /shifts/repeat` (admin) takes `{base, recurrence:{startDate,untilDate,daysOfWeek[0..6],startTime "HH:MM",endTime "HH:MM"}}`, expands occurrences (capped at 366), wraps overnight when `endTime <= startTime`, sets `isRepeat=true` and stores the pattern as JSON in `repeatPattern`. Idempotent: existing shifts at the same site + exact `startTime` are skipped, so re-running the same series is safe. Returns `{created, skippedExisting, totalOccurrences, shifts[]}`.
- **Open vacancies**: Admin dashboard surfaces an "OPEN VACANCIES" block listing the next upcoming shifts where `filled < headcount`, with per-shift `Notify` button. `POST /shifts/{id}/notify-vacancy` (admin) finds active employees with `maxLicenseLevel >= requiredLicenseLevel` who aren't already assigned, sends Expo push "🛡️ Open L{n}+ Shift — {N} vacancy/s", returns `{notifiedCount, vacanciesRemaining}`.
- **Live map**: Admin "Live Map" tab shows every clocked-in officer on a Leaflet/OpenStreetMap view (web) or list (native), refreshed every 30s. Mobile pings `POST /me/location` every 60s while clocked in; users table stores `last_lat/last_lng/last_location_at`. `GET /admin/active-officers` joins active time entries with users + shifts + sites.
- **Emergency button**: Red **press-and-hold for 3 seconds** EMERGENCY button on employee Home (prevents accidental activation). Visual fill bar + countdown ("HOLD… 3"); releasing early cancels. After the 3-second hold, `POST /emergency` creates a `severity=critical` incident, pushes "🚨 EMERGENCY ALERT" to all admins via Expo, and returns a `callNumber` (defaults to `911` (US), override via `EMERGENCY_CALL_NUMBER` env var for other regions). Mobile then offers `Linking.openURL("tel:<number>")` to dial. Web shows alert only (no auto-dial).

## Pay Run (payroll execution)

- **Page**: `/admin-portal/payroll/pay-run` (HR sidebar). Lists payroll entries (filter pending / processed / all + period range), bulk-select with checkboxes, totals bar shows count + selected net.
- **Three-step flow**: pending → **processed** (after CSV export) → **paid** (after bank confirms settlement).
- **Preview** (`POST /payroll/pay-run/preview` body `{ids[]}`) returns rows + per-row warnings (missing bank acct/routing/name, no direct-deposit consent, zero/negative net) + totals + counts (total / payable / withWarnings / alreadyPaid). Rows with warnings or already-paid are excluded from the CSV.
- **Export ACH CSV** (`POST /payroll/pay-run/export-csv` body `{ids[], batchReference?}`) downloads `wcsg-payroll-<batchId>.csv` with columns: Employee Name, Account Name, Routing Number, Account Number, Amount (USD), Pay Period Start/End, Site, Reference, Memo. Atomically marks every payable row `status='processed'`, `paidMethod='ach_csv'`, `paymentReference=<batchId>`, `paidBy=<adminUserId>`. Idempotent — re-export only flips rows that are still `pending`.
- **Mark Paid** (`POST /payroll/pay-run/mark-paid` body `{ids[], paymentReference?, method?}`) sets `status='paid'`, `paidAt=now`, `paidMethod` (`manual` default), `paymentReference`, `paidBy`. Use after the bank confirms settlement.
- **Stripe Connect (scaffolded)**: `POST /payroll/pay-run/stripe` returns **501** unless `STRIPE_CONNECT_ENABLED=true`. To activate: set the flag, add `STRIPE_SECRET_KEY`, populate each employee's connected `stripeAccountId`, and implement `stripe.transfers.create()` in the route — `stripeTransferId` column already on `payroll_entries` for the receipt.
- **Schema additions to `payroll_entries`**: `paidBy uuid → users`, `paidMethod text` (`manual|ach_csv|stripe`), `paymentReference text`, `stripeTransferId text`. Status enum extended with `failed`.
- Bank info source: `employees.bankAccountName / bankAccountNumber / bankBsb` (column names retain UK origins; UI labels are US: routing/account). `directDepositConsent` must be true for a row to be payable.

## HR pipeline (recruitment → onboarding)

- **Public application** at `/admin-portal/apply` — multi-step form (personal, right-to-work, TX security license + experience, references + photo/CV/training certs, weekly availability grid, review). Files uploaded to App Storage via presigned URLs (`POST /api/storage/uploads/request-url` → PUT to GCS). Submits to `POST /api/applications` (no auth).
- **Admin Applications** at `/admin-portal/hr/applications` — filter by status (`submitted`/`under_review`/`approved`/`rejected`), search by name/email/phone, review dialog with all uploads, mark under review / reject / **approve**.
- **Approve** creates `User` (role=`employee`, status=`pending`, random temp password) + `Employee` row + `License` row (if TX license info provided), invalidates prior unconsumed tokens, issues a 14-day single-use `OnboardingToken`, links the application via `createdEmployeeId`. Response includes `onboardingUrl`, `tempPassword`, and `emailSent:false` so the admin can copy/share.
- **Public onboarding** at `/admin-portal/onboard/:token` — GET `/api/onboarding/:token` returns prefill (name/email/phone/SSN/TX-license from application). POST submits bank/tax/W-2-or-pay-stub, emergency contact, uniform sizes, TX-license+passport docs, direct-deposit consent + signature, and 4 acknowledgements (Drug-Free, Uniform, NDA, Contract). On submit: upserts `OnboardingSubmission`, copies bank+emergency to `employees`, sets user status=`active`, consumes token, pushes admins. (DB column names retain UK origins — `sia_license_*`, `ni_number*`, `p45_doc_key` — but UI labels are TX/US.)
- **Admin Onboarding** at `/admin-portal/hr/onboarding` — list pending vs completed, detail dialog shows full submission, **Resend onboarding link** invalidates old tokens and returns a fresh link.
- Email: approve/resend send via SMTP if `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (and optionally `SMTP_FROM`) env vars are set; otherwise `emailSent:false` is returned alongside `onboardingUrl` (+ `tempPassword` for approve) so the admin can share manually. Sender lives in `artifacts/api-server/src/lib/email.ts`.
- **Approve email-conflict guard**: `POST /admin/applications/:id/approve` only re-provisions an existing user when their `role==='employee'` AND `status` is `pending`/`inactive`. Any other match (admin, active employee, etc.) returns 409 — the HR flow will never overwrite an unrelated account.
- **Request more info from applicant**: In the application review dialog, "Request more info" lets the admin tick missing fields (phone, address, DOB, SSN last 4, right-to-work doc, TX license details, photo, CV, experience, etc.) + add an optional note. `POST /admin/applications/:id/request-info` mints a 14-day single-use `application_amendment_tokens` row, invalidates prior unconsumed tokens, sets app status to `info_requested`, and emails the applicant a link to `/admin-portal/amend/:token`. The public form (`GET /applications/amend/:token`) shows only the requested fields with current values, and `POST /applications/amend/:token` enforces that **every** requested field is filled before applying updates atomically (transaction with `SELECT … FOR UPDATE` on the token), bumping status back to `under_review` and pushing admins.
- **Batch request more info**: Applications page has row checkboxes (disabled for `approved`/`rejected`) + a sticky navy toolbar that appears when ≥1 row is selected. "Request more info from N" opens `BatchRequestInfoDialog` listing recipients + the same 15 amendable fields with per-field "X of N missing this" hints + shared note. Sends in parallel via the existing per-app `/admin/applications/:id/request-info` endpoint (concurrency capped at 4 workers, each request independently try/catch'd) — no new server endpoint. `BatchResultDialog` shows emailed/link-only/failed counts, lists failures by name, and provides copy buttons for any link-only successes (when SMTP isn't configured).

## Invitations (bulk temp passwords + invite emails)

- **Page**: `/admin-portal/hr/invitations` (HR sidebar). Two-phase admin workflow.
- **Phase 1 — Generate temp passwords**: `POST /admin/users/bulk-temp-passwords` body `{ scope: "all_non_admin"|"by_ids", userIds?, force? }`. For each non-admin user it generates a 10-char password (avoids ambiguous 0/O/1/I/l), bcrypts it into `users.password_hash`, stores plaintext in `users.temp_password_plain`, sets `temp_password_set_at`, sets `must_change_password=true`, and clears `invited_at` (rotating re-arms the invite). Default `force=false` skips users that already have an unsent temp password (so re-running is idempotent). Admins (role='admin') are NEVER targeted.
- **Phase 2 — Send invites**: `POST /admin/users/bulk-invite` body `{ userIds[] }`. For each selected user with a stored temp password, sends `renderInviteEmail` (sign-in URL + email + temp password) via SMTP. On successful send, **clears `temp_password_plain` and stamps `invited_at`** so the password no longer sits in the DB. Failures (no temp pw, no SMTP, no base URL) are returned per row.
- **List**: `GET /admin/users/invitations` returns non-admin users with `tempPasswordPlain` (admin-only) for the page table.
- **Page UX**: 4 stat tiles (Total / No password / Ready to invite / Invited), filter chips, search, row checkboxes, sticky toolbar when ≥1 selected with **Send invite to N** + **Regenerate password**, per-row hide/show + copy temp password, **Download credentials CSV** for all "ready to invite" rows, regenerate-with-force confirm dialog, results dialog with sent/failed breakdown.
- **Schema additions to `users`**: `temp_password_plain text` (nullable, cleared on invite), `temp_password_set_at timestamptz`, `invited_at timestamptz`.
- **Sensitive-data redaction**: generic `/admin/tables/users` GET now strips `passwordHash` and `tempPasswordPlain` from rows. Use the dedicated `/admin/users/invitations` endpoint to read temp passwords.
- **Sign-in URL** is built from `APP_BASE_URL` (preferred) or `REPLIT_DOMAINS`, same as the password-reset flow.

## Seeded Accounts

- Admin: `admin@secureops.com` / `Admin123!`
- Employee: `john.smith@secureops.com` / `Employee123!`
- Both are provisioned idempotently on every API server boot by `seedDemoUsers()` in `artifacts/api-server/src/lib/seedDemoUsers.ts`. If the user already exists with the documented password, nothing changes; otherwise the password is reset to the documented value and a missing employees row is created. Disable with `SEED_DEMO_USERS=false` (e.g. in production).

## User preferences

- Brand: deep navy #080c18, rich gold #c9a84c, warm cream #f0e6c8
- Company name: Williams Council Security Group (WCSG)

## Admin Portal

- Web app at `/admin-portal/` (Vite, port 25580). Sidebar lists all 11 DB tables; generic sortable/filterable/paginated grid with inline Add/Edit/Delete; FK columns render as searchable dropdowns. All writes hit `/api/admin/...` and are validated server-side via drizzle-zod insert schemas.
- Excel/CSV bulk import for **users / employees / clients / sites** with column mapping + validation preview + error CSV download. The mapping step also lets you set a **default value** for any unmapped field — essential for Sites import (Glide CSV has no `clientId`, so pick one Client to attach all rows to).
- Brand: navy sidebar `#080c18`, gold accents `#c9a84c`, cream background `#f0e6c8`, "Williams Council Security Group" wordmark in Georgia serif.
- Auth: login via `/api/auth/login`; JWT stored in `localStorage` under `wcsg.adminToken`; non-admin users see an "Admin access required" screen.

## Gotchas

- **Decline frees the slot**: `PUT /shifts/{id}/assignments/{assignmentId}` with `{status:"declined"}` DELETES the row and returns `{removed:true}` so the slot is freed for re-claim. (Reserve / admin "+" both create `accepted` directly — there is no longer a `pending` confirmation step.)
- **Orval signature**: list hooks now take `(params, { query: { queryKey } })` — NOT `{ params, query }` wrapped. Mutation hooks take `{id, data}` (or `{id, assignmentId, data}` for nested), not `{id, ...body}`.
- Orval codegen regenerates `lib/api-zod/src/index.ts` — the codegen script has a post-step to rewrite it to only export from `./generated/api` (avoids TS2308 duplicate export error from types conflict).
- WebSocket clients connect via `wss://<domain>/api/ws?token=<jwt>` — the proxy routes this correctly.
- expo-notifications on web shows a warning but does not crash — push token registration is skipped on web.
- `pnpm --filter @workspace/db run push` must be re-run whenever DB schema changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
