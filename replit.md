# Williams Council Security Group — SecureOps Platform

A full-stack mobile operations platform for Williams Council Security Group (WCSG), covering recruitment through operational control for private security officers.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — JWT signing key

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
- `artifacts/api-server/src/routes/storage.ts` + `src/lib/{objectStorage,objectAcl}.ts` — App Storage upload URL + file serving
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
- **Admin**: Manage clients (with payment terms) + sites; post shifts on sites with bill/pay rates + required licence level + headcount; approve time entries; generate weekly payroll per (employee × site × week) from approved hours; generate weekly invoices per (client × site × week) at billRate × approved hours, due date = invoice date + client.paymentTermsDays; mark payroll/invoices paid manually; review incidents; track licences; broadcast via team chat.
- **Employee**: See highest current clearance on profile; browse "Available" shifts they qualify for; **one-tap Reserve** books the shift immediately (`POST /shifts/:id/claim` inserts an `accepted` assignment); officer can later Decline to release the slot; GPS clock in/out (entries start `pending` admin approval); report incidents; team chat.
- **Licence hierarchy**: L2 unarmed (lowest) → L3 armed (covers L2+L3) → L4/PPO (covers all). `maxLicenseLevel` = MAX(level) of unexpired licences.
- **Atomic shift claim**: `POST /shifts/{id}/claim` runs inside a transaction that locks the shift row (`SELECT … FOR UPDATE`) and re-counts assignments before inserting, preventing races from overfilling. Creates an `accepted` assignment (one-tap Reserve = booked) and sends "✅ Shift Reserved" Expo push. Admin "+" (`POST /shifts/{id}/assignments`) likewise creates `accepted` directly.
- **Currency**: USD ($) throughout admin payroll/invoice screens.
- **Chat**: Replaces WhatsApp — real-time team messaging with named channels, persistent message history, WebSocket delivery.
- **Notifications**: Push alerts on shift assignment (iOS/Android); web degrades gracefully.
- **Open vacancies**: Admin dashboard surfaces an "OPEN VACANCIES" block listing the next upcoming shifts where `filled < headcount`, with per-shift `Notify` button. `POST /shifts/{id}/notify-vacancy` (admin) finds active employees with `maxLicenseLevel >= requiredLicenseLevel` who aren't already assigned, sends Expo push "🛡️ Open L{n}+ Shift — {N} vacancy/s", returns `{notifiedCount, vacanciesRemaining}`.
- **Live map**: Admin "Live Map" tab shows every clocked-in officer on a Leaflet/OpenStreetMap view (web) or list (native), refreshed every 30s. Mobile pings `POST /me/location` every 60s while clocked in; users table stores `last_lat/last_lng/last_location_at`. `GET /admin/active-officers` joins active time entries with users + shifts + sites.
- **Emergency button**: Red EMERGENCY button on employee Home. `POST /emergency` creates a `severity=critical` incident, pushes "🚨 EMERGENCY ALERT" to all admins via Expo, and returns a `callNumber` (defaults to `911` (US), override via `EMERGENCY_CALL_NUMBER` env var for other regions). Mobile then offers `Linking.openURL("tel:<number>")` to dial. Web shows alert only (no auto-dial).

## HR pipeline (recruitment → onboarding)

- **Public application** at `/admin-portal/apply` — multi-step form (personal, right-to-work, TX security license + experience, references + photo/CV/training certs, weekly availability grid, review). Files uploaded to App Storage via presigned URLs (`POST /api/storage/uploads/request-url` → PUT to GCS). Submits to `POST /api/applications` (no auth).
- **Admin Applications** at `/admin-portal/hr/applications` — filter by status (`submitted`/`under_review`/`approved`/`rejected`), search by name/email/phone, review dialog with all uploads, mark under review / reject / **approve**.
- **Approve** creates `User` (role=`employee`, status=`pending`, random temp password) + `Employee` row + `License` row (if TX license info provided), invalidates prior unconsumed tokens, issues a 14-day single-use `OnboardingToken`, links the application via `createdEmployeeId`. Response includes `onboardingUrl`, `tempPassword`, and `emailSent:false` so the admin can copy/share.
- **Public onboarding** at `/admin-portal/onboard/:token` — GET `/api/onboarding/:token` returns prefill (name/email/phone/SSN/TX-license from application). POST submits bank/tax/W-2-or-pay-stub, emergency contact, uniform sizes, TX-license+passport docs, direct-deposit consent + signature, and 4 acknowledgements (Drug-Free, Uniform, NDA, Contract). On submit: upserts `OnboardingSubmission`, copies bank+emergency to `employees`, sets user status=`active`, consumes token, pushes admins. (DB column names retain UK origins — `sia_license_*`, `ni_number*`, `p45_doc_key` — but UI labels are TX/US.)
- **Admin Onboarding** at `/admin-portal/hr/onboarding` — list pending vs completed, detail dialog shows full submission, **Resend onboarding link** invalidates old tokens and returns a fresh link.
- Email: approve/resend send via SMTP if `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (and optionally `SMTP_FROM`) env vars are set; otherwise `emailSent:false` is returned alongside `onboardingUrl` (+ `tempPassword` for approve) so the admin can share manually. Sender lives in `artifacts/api-server/src/lib/email.ts`.
- **Approve email-conflict guard**: `POST /admin/applications/:id/approve` only re-provisions an existing user when their `role==='employee'` AND `status` is `pending`/`inactive`. Any other match (admin, active employee, etc.) returns 409 — the HR flow will never overwrite an unrelated account.

## Seeded Accounts

- Admin: `admin@secureops.com` / `Admin123!`
- Employee: `john.smith@secureops.com` / `Employee123!`

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
