---
name: admin-portal HTTP paths & 401 auto-logout
description: Admin-portal has THREE authenticated HTTP paths (api(), fetchWithAuth, generated orval customFetch); cross-cutting request behavior (401 auto-logout, auth headers) must cover ALL of them.
---

The admin-portal does NOT route all HTTP through one helper. There are three
authenticated paths:

- `api()` (`src/lib/api.ts`) — JSON-in/JSON-out; throws `ApiError`. Used by grids, dashboards, most CRUD.
- `fetchWithAuth()` (`src/lib/api.ts`) — returns the raw `Response`; used for blob/PDF/CSV downloads
  and callers needing custom status handling (PayRun, SubcontractorPayRun, Exports,
  DailyReports, Radio audio, AuditLog, DataGrid/RowFormDialog PDFs, Client*).
- **Generated orval hooks** (`@workspace/api-client-react` → `custom-fetch.ts`) — used by
  Dashboard, Analytics, SiteDetailPage. Auth is wired PER BUNDLE via a module-level
  `setAuthTokenGetter(getToken)` (lives at top of `src/lib/api.ts`). **This wiring was
  missing until July 2026** — every generated hook silently sent NO Authorization header
  and 401'd in the browser ("failing to load data") while curl tests with explicit
  headers passed. Any new web bundle consuming the generated client must call
  `setAuthTokenGetter` before the first query.

**Rule:** any cross-cutting authenticated-request behavior (401 auto-logout,
ret/auth headers, tracing) must live in BOTH `api()` and `fetchWithAuth()`, or be
funneled through them. Before assuming "all requests go through api()", grep for
bare `fetch(` + `Authorization`/`Bearer` — historically ~25 callsites across ~11
pages built their own headers and bypassed `api()` entirely.

**Why:** the session-expiry auto-logout fix initially only patched `api()`, so
PDF/CSV/payroll/audit screens still dead-ended on an expired token. Fix was to add
`fetchWithAuth` (mirrors api()'s `status===401 && tokenWasSent => _unauthorizedHandler()`)
and migrate every authenticated bare-fetch callsite to it.

**401 auto-logout gating (all clients):** fire the unauthorized handler ONLY when
the rejected request actually carried a token, so failed LOGIN attempts and
pre-login polling don't force a logout. Handler = clear token + clear user; the
router then falls back to the login screen. Genuinely public endpoints
(public share token-in-URL, `/api/brand`, GCS presigned upload) must stay on bare
`fetch` — no token, no logout.

**Shared lib parity:** the same pattern lives in `lib/api-client-react`
(`custom-fetch.ts` `setUnauthorizedHandler`/`notifyUnauthorized`, gated on
`headers.has("authorization")`), consumed by the Expo app's hand-written
`utils/api.ts` and registered once in each app's AuthProvider via a mount-once
`useEffect` (single global handler, last-mount-wins — fine since each app has one
AuthProvider). After editing the shared lib, restart the expo + admin-portal
workflows so Metro/Vite pick up the new exports.
