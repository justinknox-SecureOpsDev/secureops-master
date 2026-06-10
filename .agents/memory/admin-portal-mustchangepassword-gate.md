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
