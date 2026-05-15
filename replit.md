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
- `artifacts/admin-portal/src/components/{DataGrid,RowFormDialog,ImportWizard}.tsx`
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
- **Employee**: See highest current clearance on profile; browse "Available" shifts they qualify for; **explicitly Accept or Decline** each assignment (claim creates `pending`, accept → `accepted`, decline → row deleted, slot freed); GPS clock in/out (entries start `pending` admin approval); report incidents; team chat.
- **Licence hierarchy**: L2 unarmed (lowest) → L3 armed (covers L2+L3) → L4/PPO (covers all). `maxLicenseLevel` = MAX(level) of unexpired licences.
- **Atomic shift claim**: `POST /shifts/{id}/claim` uses a single SQL `INSERT ... WHERE NOT EXISTS ... AND count < headcount` to prevent races overfilling shifts; creates `pending` assignment + sends "🕒 Confirm Your Shift" Expo push.
- **Currency**: GBP (£) throughout admin payroll/invoice screens.
- **Chat**: Replaces WhatsApp — real-time team messaging with named channels, persistent message history, WebSocket delivery.
- **Notifications**: Push alerts on shift assignment (iOS/Android); web degrades gracefully.
- **Live map**: Admin "Live Map" tab shows every clocked-in officer on a Leaflet/OpenStreetMap view (web) or list (native), refreshed every 30s. Mobile pings `POST /me/location` every 60s while clocked in; users table stores `last_lat/last_lng/last_location_at`. `GET /admin/active-officers` joins active time entries with users + shifts + sites.
- **Emergency button**: Red EMERGENCY button on employee Home. `POST /emergency` creates a `severity=critical` incident, pushes "🚨 EMERGENCY ALERT" to all admins via Expo, and returns a `callNumber` (defaults to `999` (UK), override via `EMERGENCY_CALL_NUMBER` env var (e.g. `911`)). Mobile then offers `Linking.openURL("tel:<number>")` to dial. Web shows alert only (no auto-dial).

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

- **Explicit-acceptance flow**: `PUT /shifts/{id}/assignments/{assignmentId}` with `{status:"declined"}` DELETES the row and returns `{removed:true}` so the slot is freed for re-claim. Accepted/pending are separate states — only `accepted` rows count toward filled headcount once flow is fully gated.
- **Orval signature**: list hooks now take `(params, { query: { queryKey } })` — NOT `{ params, query }` wrapped. Mutation hooks take `{id, data}` (or `{id, assignmentId, data}` for nested), not `{id, ...body}`.
- Orval codegen regenerates `lib/api-zod/src/index.ts` — the codegen script has a post-step to rewrite it to only export from `./generated/api` (avoids TS2308 duplicate export error from types conflict).
- WebSocket clients connect via `wss://<domain>/api/ws?token=<jwt>` — the proxy routes this correctly.
- expo-notifications on web shows a warning but does not crash — push token registration is skipped on web.
- `pnpm --filter @workspace/db run push` must be re-run whenever DB schema changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
