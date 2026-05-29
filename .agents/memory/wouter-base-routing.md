---
name: wouter base-path routing gotcha
description: Why bare-base URLs 404 in the admin-portal SPA and how the root fallback fixes it
---

# wouter bare-base 404 gotcha (admin-portal)

The admin-portal mounts `<Router base={import.meta.env.BASE_URL.replace(/\/$/, "")}>` = `/admin-portal`.
When the browser URL is the **bare base with no trailing slash** (`/admin-portal`), wouter's
`useLocation()` returns `""` (empty string), which does **not** match `<Route path="/">`. The Switch
then falls through to the `NotFound` 404. With a trailing slash (`/admin-portal/`) the location is `"/"`
and matches normally.

**Symptom:** users hit a 404 on first login / when landing on the bare base; clicking any nav link
(which navigates to a concrete path like `/client` or `/dispatch`) clears it.

**Fix pattern (used in ClientShell.tsx and App.tsx):** make the catch-all fallback root-aware instead of
plain `NotFound` — if location is `""` (and `"/"` for the client shell), redirect to the role's home
(`/client` for clients, `/` → home-redirect for admin/dispatcher); otherwise render `NotFound`. This keeps
real unknown paths 404ing while fixing bare-base landings.

**Also:** outbound invite/login links should point at a concrete route (e.g. `${base}/admin-portal/client`)
rather than the bare base, so they never depend on root-redirect behavior.

**Why:** wouter treats the exact-base path as empty, not `/`. Any new role shell with its own `<Switch>`
under this router inherits the same risk — give it a root-aware fallback.
