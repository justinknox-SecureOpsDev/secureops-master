# Threat Model

## Project Overview

SecureOps is a production mobile and web operations platform for a private security company. It uses an Express 5 API (`artifacts/api-server/src`), PostgreSQL via Drizzle, a React/Vite admin portal (`artifacts/admin-portal`), and an Expo mobile app (`artifacts/security-ops`). The system handles employee accounts, HR applications/onboarding, incident reports, shift scheduling, payroll/invoicing, chat, live location, and private document storage in Replit-managed object storage.

Production scope for this scan is the API server plus the admin portal and mobile app surfaces that can drive production API behavior. `artifacts/mockup-sandbox` is dev-only and should be ignored unless a production path is shown to depend on it. Per platform assumptions, production traffic is already protected by TLS and `NODE_ENV` is `production`.

## Assets

- **User accounts and session tokens** — JWTs, password hashes, temporary passwords, password-reset tokens, onboarding/amendment tokens, and Expo push tokens. Compromise enables impersonation and lateral access across admin and employee features.
- **HR and employee PII** — application data, SSN last 4, birth data, right-to-work docs, license docs, passports, addresses, emergency contacts, payroll/banking data, and signatures. This is the most sensitive business data in the system.
- **Operational data** — incidents, location pings, active-officer map data, shift assignments, chat messages, and emergency alerts. Exposure can endanger officer safety and reveal sensitive client/site information.
- **Financial data** — payroll entries, routing/account numbers, invoice data, and payment execution metadata. Integrity and confidentiality both matter.
- **Stored files** — uploaded application documents, onboarding documents, incident attachments, and policy PDFs stored in object storage. These must not be readable or writable outside intended ownership/admin flows.
- **Application secrets** — `SESSION_SECRET`, database credentials, SMTP credentials, and object-storage signing capabilities. Leakage would enable session forgery, data theft, or phishing.

## Trust Boundaries

- **Public client to API** — unauthenticated users can reach login, password reset, public application submission, token-based onboarding/amendment flows, and upload-URL issuance. All client input is untrusted.
- **Authenticated employee to API** — employees can access shifts, chat, incidents, profile, location updates, and self-serve storage signing. Employee permissions must stay scoped to their own data and allowed shared spaces.
- **Admin to API** — admins can access generic CRUD, HR approval/onboarding tools, payroll/invoicing, storage signing, and live officer views. Admin-only boundaries are high impact because they expose global data sets.
- **API to PostgreSQL** — the API has broad read/write access to sensitive relational data. Broken authorization or unsafe query construction here exposes full business and personnel records.
- **API to object storage** — the API mints signed URLs and proxies downloads for private files. Ownership checks and upload constraints must be enforced server-side.
- **API to external messaging services** — SMTP and Expo push are outbound channels carrying sensitive workflow links and notifications. Link generation must rely on trusted origins, and notification content must not leak unauthorized data.
- **WebSocket boundary** — `/api/ws` upgrades an authenticated HTTP connection into a long-lived channel. Message fan-out must preserve room membership and role boundaries, not just authentication.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/routes/*.ts`, `artifacts/api-server/src/middlewares/auth.ts`, `artifacts/api-server/src/lib/wsManager.ts`.
- **Highest-risk areas:** HR/onboarding (`routes/applications.ts`), auth/password reset (`routes/auth.ts`), chat/WebSocket (`routes/chat.ts`, `lib/wsManager.ts`), object storage (`routes/storage.ts`, `lib/objectStorage.ts`), payroll/admin CRUD (`routes/payroll.ts`, `routes/admin.ts`), live ops (`routes/liveOps.ts`).
- **Public surfaces:** `/auth/login`, `/auth/forgot-password`, `/auth/reset-password`, `/applications`, `/applications/amend/:token`, `/onboarding/:token`, `/storage/uploads/request-url`, `/storage/public-objects/*`.
- **Authenticated employee surfaces:** `/shifts`, `/incidents`, `/licenses`, `/chat/*`, `/me/location`, `/emergency`, `/me/storage/sign`, `/me/employee`.
- **Admin-only surfaces:** `/admin/*`, `/clients*`, `/sites*`, `/payroll*`, `/invoices*`, `/storage/objects/*`, `/admin/storage/sign`, admin onboarding/application flows.
- **Usually dev-only:** `artifacts/mockup-sandbox`, local seeds/scripts, build tooling, generated clients unless a server path depends on them.

## Threat Categories

### Spoofing

The system depends on bearer JWTs for both REST and WebSocket access. Every protected route and socket upgrade must require a valid token, and privileged flows must not issue usable credentials that are predictable from applicant data. Password-reset, onboarding, and amendment links must be high-entropy, single-use, and delivered through trusted origins only.

### Tampering

Clients can submit shift claims, incidents, HR data, payroll actions, uploads, and profile changes. The API must calculate authoritative business decisions server-side, use narrow allow-lists for writable fields, and reject attempts to post into rooms, records, or file paths outside the caller's allowed scope.

### Information Disclosure

This project stores unusually sensitive HR, banking, incident, and live-location data. API responses, WebSocket broadcasts, document-signing endpoints, admin grids, and error/logging behavior must not expose another employee's records, private documents, direct messages, or reset/onboarding secrets.

### Denial of Service

Public application and upload flows can be triggered without authentication, and several endpoints invoke storage signing, email, or expensive DB work. Production endpoints that mint upload URLs, send emails, or accept large user-controlled bodies must bound request rate, object size/count, and downstream resource usage.

### Elevation of Privilege

Role separation between admin and employee is central to the product. Missing membership checks on chat/direct-message routes, broken ownership checks on documents, or allowing pending/untrusted accounts to act like active employees would let attackers reach data and operations beyond their intended role. Generic admin CRUD and token-scoped onboarding flows are especially sensitive and must enforce server-side authorization on every request.

## Recent Hardening (May 2026 launch pack)

The P0 launch security pack tightened the controls described above. When re-scanning, treat the following as the current baseline:

- **CORS** is locked to `ALLOWED_ORIGINS ∪ REPLIT_DOMAINS` in `artifacts/api-server/src/app.ts`. Requests with no `Origin` header (native app / curl) are allowed; unknown browser origins are rejected.
- **Helmet** is enabled with `crossOriginResourcePolicy: cross-origin` (so signed object-storage downloads can be embedded by the portal and mobile app). Content-Security-Policy is enabled in production with a tuned directive set; disabled in dev to keep Vite HMR working.
- **Rate limiters** (`middlewares/rateLimit.ts`):
  - login (existing): 10 / 15 min / IP and per-email
  - forgot-password (existing): 5 / hour / IP and per-email
  - `publicApplicationLimiter`: 5 / hour / IP on `POST /applications`
  - `tokenLookupLimiter`: 60 / 5 min / IP on GET+POST `/applications/amend/:token` and `/onboarding/:token`
  - `emergencyLimiter`: 5 / min / user on `POST /emergency`
  - existing per-IP cap on `/storage/uploads/request-url` and `/storage/uploads/application-url`
- **JWT revocation** uses two complementary mechanisms, both checked in `requireAuth` AND in the `/api/ws` upgrade in `lib/wsManager.ts`:
  - `users.tokens_valid_after` watermark — bumped by `POST /auth/logout-all` (self) or `POST /admin/users/:id/revoke-sessions` (admin). Tokens with `iat < tokensValidAfter` are rejected.
  - `revoked_tokens` table keyed by `jti` — written by `POST /auth/logout`. Looked up per request.
  - Expired `revoked_tokens` rows are cleaned up hourly by `lib/scheduledJobs.ts`.
- **Sensitive-data redaction** on `/admin/tables/users` strips `passwordHash` and `tempPasswordPlain` from list/get responses; only the dedicated `/admin/users/invitations` endpoint returns temp passwords.
- **System status surface**: `GET /admin/system/status` (admin-only) returns booleans for SMTP / SESSION_SECRET / base-URL / CORS configuration. Used by the admin shell to render an amber "degraded configuration" banner. The server also logs error-level messages at boot if any of these are missing in production.
- **Public legal surface**: `/admin-portal/{privacy,terms,data-rights}` are publicly accessible and linked from the admin Apply page, admin Login, and the mobile login screen.
- **DB indexes** on hot lookup paths: `shifts(siteId,startTime)`, `shiftAssignments(shiftId,status)`, `timeEntries(employeeId,clockInTime)`, `chatMessages(roomId,createdAt)`, `incidents(employeeId,occurredAt)`, plus `revoked_tokens(userId)` and `revoked_tokens(expiresAt)`.

## Production deployment checklist

These environment variables must be set on the deployed environment for the hardening above to be fully effective. Missing values are surfaced via boot-time `logger.error` and the admin shell banner.

- `SESSION_SECRET` — ≥16 chars, high-entropy. Production hard-fails at boot if missing/short.
- `DATABASE_URL` — Postgres connection string (already required).
- `ALLOWED_ORIGINS` — comma-separated list of browser origins that may call the API. `REPLIT_DOMAINS` is automatically added on top.
- `APP_BASE_URL` — public origin used to build links inside outbound emails (password reset, onboarding, amendment, invites). Falls back to `REPLIT_DOMAINS` if unset.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `SMTP_FROM` — required for invitation, password-reset, onboarding, and amendment emails to actually leave the building.
- `EMERGENCY_CALL_NUMBER` — dial-out number for the panic button (defaults to `911`).
- `SEED_DEMO_USERS=false` — set in production to prevent the demo `admin@secureops.com` / `john.smith@secureops.com` accounts from being re-provisioned.