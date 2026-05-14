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
- DB: PostgreSQL + Drizzle ORM (11 tables)
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
- `artifacts/security-ops/` — Expo mobile app
- `artifacts/security-ops/contexts/ChatContext.tsx` — WebSocket chat context
- `artifacts/security-ops/components/chat/` — Chat UI components
- `artifacts/security-ops/hooks/useNotifications.ts` — Push notification registration

## Architecture decisions

- **Contract-first API**: OpenAPI YAML is the source of truth; hooks and Zod schemas are generated from it.
- **WebSocket at `/api/ws`**: Same port as HTTP server; JWT token passed as query param for auth; broadcasts chat messages to all connected clients.
- **Expo Push API**: Uses `expo-server-sdk` on the server to send notifications; tokens stored in users table; degrades gracefully on web/simulator.
- **Chat General room**: Auto-created on first `/chat/rooms` GET; admins can create additional channels.
- **Role-based nav**: Admin gets 5 tabs (Dashboard, Personnel, Shifts, Incidents, Chat); Employee gets 5 tabs (Home, My Shifts, Clock, Incidents, Chat).

## Product

- **Admin**: Manage employees, schedule shifts, process payroll, generate invoices, review incidents, track licenses, broadcast messages via team chat.
- **Employee**: View assigned shifts, GPS clock in/out, report incidents, see profile, message team via chat.
- **Chat**: Replaces WhatsApp — real-time team messaging with named channels, persistent message history, WebSocket delivery.
- **Notifications**: Push alerts on shift assignment (iOS/Android); web degrades gracefully.

## Seeded Accounts

- Admin: `admin@secureops.com` / `Admin123!`
- Employee: `john.smith@secureops.com` / `Employee123!`

## User preferences

- Brand: deep navy #080c18, rich gold #c9a84c, warm cream #f0e6c8
- Company name: Williams Council Security Group (WCSG)

## Gotchas

- Orval codegen regenerates `lib/api-zod/src/index.ts` — the codegen script has a post-step to rewrite it to only export from `./generated/api` (avoids TS2308 duplicate export error from types conflict).
- WebSocket clients connect via `wss://<domain>/api/ws?token=<jwt>` — the proxy routes this correctly.
- expo-notifications on web shows a warning but does not crash — push token registration is skipped on web.
- `pnpm --filter @workspace/db run push` must be re-run whenever DB schema changes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
