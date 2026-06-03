---
name: Officers landing on admin portal
description: Why employees who sign into the admin portal are redirected to the SecureOps app root instead of being shown a dead-end.
---

# Officers on the admin portal

Employees/officers (role=`employee`) routinely open the **admin portal** URL
(`/admin-portal/`) on their phones — via old invite-email links, bookmarks, or
word of mouth — sign in successfully, and previously hit a dead-end
"Admin access required" screen in `admin-portal/src/App.tsx`'s role gate.

**Rule:** The admin portal's non-admin/non-dispatcher/non-client branch must
NOT dead-end employees. It redirects them to the SecureOps officer app served at
the domain **root `/`** (clears the admin-portal token first). Keep this
behavior — do not reintroduce a dead-end screen for employees.

**Why:** Officers can always reach the admin portal URL; the graceful path is to
bounce them to where they actually belong. The officer app is mounted at `/`,
admin portal at `/admin-portal/`, so the redirect target is outside the portal
base path (no loop). Confirmed by both artifact.toml routing files.

**How to apply:** Any future change to the admin-portal route guard / login
gating, or to invite/reset email link targets, must keep officers pointed at the
SecureOps app root, not the admin portal.
