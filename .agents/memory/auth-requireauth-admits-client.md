---
name: requireAuth admits the client role
description: Why employee/internal-data endpoints must not use bare requireAuth, and which guard to use instead.
---

# `requireAuth` admits external `client` portal users

`requireAuth` in `artifacts/api-server/src/middlewares/auth.ts` lets through ANY
active authenticated user — roles `admin`, `dispatcher`, `employee`, AND
`client`. The `client` role is an external venue contact, not staff, and is
supposed to only ever see data scoped to its own org's sites (via
`getClientSiteIds`).

**Rule:** an endpoint that returns internal/operational data (site lists,
officer data, ops surfaces) and is meant for staff/officers must NOT be guarded
by bare `requireAuth` — that silently exposes the data to client-portal users
(cross-tenant disclosure). Use `requireStaff` (admin/dispatcher/employee,
excludes client). For admin-only use `requireAdmin`; for the dispatch surface
`requireAdminOrDispatcher`; for client-scoped endpoints `requireClient` +
`getClientSiteIds`.

**Why:** the officer web clock-in site picker (`/me/clock-in-sites`) originally
shipped with `requireAuth`; a code review flagged that any `client` token would
then receive every site's name/address/coordinates. Fixed by adding and using
`requireStaff`.

**How to apply:** when adding any `/me/*` or employee-facing route, ask "should a
client user see this?" If no, reach for `requireStaff`, not `requireAuth`.
