---
name: admin-portal mustChangePassword gate
description: Why invited client (and any temp-password) users need a first-login password-change screen in the admin portal
---

Invited client-portal users (and anyone provisioned with a temp password) are
created with `mustChangePassword: true`. `/auth/login` still issues a valid
token, but `requireAuth` then blocks **every** non-`/auth/*` route with **403**
("You must change your password...") until the flag clears. So a portal with no
first-login change-password UI is fully unusable for those users — pages just
error out (a user may report this loosely as "401").

**Rule:** any portal/shell that can host temp-password users must gate the whole
app behind a mandatory change-password screen when `user.mustChangePassword`,
placed BEFORE role routing (covers client/admin/dispatcher/employee alike). The
admin portal hosts the client portal, so this lives in admin-portal `App.tsx`.

**Why:** the mobile app always had this screen; the admin portal didn't, and
client invites started landing there.

**How to apply:**
- `/auth/change-password` rotates the JWT (bumps `tokensValidAfter`, clears the
  flag) and returns a fresh `{ token, user }`. Swap it in via an auth-context
  method (`applySession`) — the old token is invalidated.
- Call it with a **raw fetch**, NOT the shared `api()` helper: a wrong current
  password returns **401**, and `api()` fires the global unauthorized→logout
  handler, which would bounce the user to login instead of showing an inline
  "current password is incorrect".
- `/auth/me` (bootstrap on refresh) returns `mustChangePassword`, so the gate
  survives a hard refresh.

## Related: `/client*` routes are client-role only

The `/client*` routes exist only inside `ClientShell`, rendered only for
`role === "client"`. An admin/dispatcher who opens a client sign-in link or
bookmark (e.g. the URL in a client invite email) lands on `/client` in the
admin router and dead-ends on the dev-facing "404 Page Not Found — Did you
forget to add the page to the router?". Admins have no client account, so
`App.tsx` redirects any admin/dispatcher hitting `/client` or `/client/*` back
to admin home (`/`) before the role switch. A logged-out visitor on the same
link is fine: they hit LoginPage, then after a client login `ClientShell`
renders the matching `/client*` route.
