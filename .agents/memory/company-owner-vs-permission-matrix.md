---
name: Company-owner flag vs. custom role-permission matrix
description: Two independent authorization axes added for financial-dashboard security — when to use which, and the gating-strategy split that made them coexist cleanly.
---

## The two axes are orthogonal, never merge them

- **`users.isCompanyOwner`** (boolean, independent of `role`): gates ONLY the
  company-wide *aggregate* financial picture — revenue/margin/profit KPIs,
  payroll/invoice board totals, financial exports, analytics. It is not a
  role and must never be checked via role name.
- **Permission matrix** (`permission_overrides` table, keyed by permission
  key × allowed roles, mirrors the feature-flag system's shape): gates
  *day-to-day module actions* (scheduling, time & attendance, personnel,
  dispatch, and single-record finance transactions) per role, admin-editable,
  no redeploy needed.
- Platform super-admin stays 100% env-driven (`SUPER_ADMIN_EMAILS`) and must
  stay unreachable from both of the above — never let a grant/revoke route
  touch `role` or read/write anything platform-related.

**Why:** the task explicitly separated "seeing the company's aggregate
financial picture" (owner flag) from "doing transaction-level bookkeeping on
one record" (a permission, `finance.transactions`) — conflating them would
let a mis-scoped permission grant leak aggregate financials, or let an owner
grant/revoke accidentally touch role-based capabilities.

## Gating-strategy split: full-gate vs. sanitize-in-place

- Endpoints that are **wholly** an aggregate financial dashboard/board/export
  (analytics summary, payroll board, invoice board, subcontractor pay-run
  preview/export, the finance-gated custom-export dataset) get a hard
  `requireCompanyOwner` 403 — no partial view.
- Endpoints that legitimately serve **mixed** data (some financial fields,
  mostly not) get response sanitization instead: `stripDashboardFinanceForOwner`
  recursively strips a fixed field-name allowlist (`DASHBOARD_FINANCE_FIELDS`
  in `financeVisibility.ts`) rather than blocking the whole response.
- A route with a dollar-shaped name is not automatically financial — e.g.
  `/dashboard/admin-summary`'s `pendingPayroll` is a **count**, not a dollar
  total, so it stays visible to any admin with no gating needed. Check the
  actual field type before adding it to the strip list or gating the route.
- `GET /payroll` and `GET /invoices` (plain lists, not just the "board" view)
  were initially folded into the full-gate set, then reopened to
  owner-OR-`finance.transactions` with sanitize-in-place, because a
  bookkeeper who can edit a record by ID but cannot list records has no way
  to find one. The BOARD endpoints (`/payroll/board`, aggregate roll-ups)
  stay hard-gated; only the flat record lists are shared.

The line is AGGREGATE vs SINGLE RECORD, not "any dollar figure". The
transactional permission necessarily lets its holder see one record's own
amounts (they can price, edit and send that record); only the company-wide
picture is owner-only. **How to apply:** don't "fix" a per-record detail
route that shows amounts to a permission holder — that is the grant working.
Do question any route that aggregates across records.

## Client-side permission gating needs the key list on the user object

A permission-gated surface can't decide what to render from `role` alone,
because the matrix is admin-editable at runtime; the session identity must
carry the caller's effective keys. Treat that list as advisory routing
information only — the server re-checks the same matrix.
**Why:** a client that guesses from role either hides a granted surface or
fires requests that are guaranteed to 403.

Granting a permission is not the same as making its surface reachable: the
portal admits only some roles, and each role branch has its own routes and
navigation. A surface newly opened to another role must be added to that
role's branch too, or the grant is invisible.

## Reuse the existing live-reload, don't invent a new one

`requireAuth` already reloads the live `users` row every request (originally
for other live fields). Adding `isCompanyOwner` to that same select means
revoking the flag takes effect on the very next request with the same
pre-issued JWT — no re-login, no token versioning needed. Never sign
`isCompanyOwner` into the JWT payload itself, or revocation would require
waiting for token expiry.

## A rollout backfill for an authorization flag needs a durable "ran once" marker, not a per-row re-check

A per-boot backfill condition like `role = admin AND is_company_owner = false`
looks idempotent but is actually an access-control bypass: if an owner later
*deliberately* revokes the flag from a user who is still `admin`, the very
next restart's backfill sees that same row (still admin, still flag=false)
and silently re-grants it — undoing the revocation with no audit trail.
Use an atomic one-time claim instead: insert a singleton marker row via
`INSERT ... ON CONFLICT DO NOTHING ... RETURNING`, and only run the actual
backfill UPDATE when that insert returns a row (i.e., this is truly the
first time ever). Every later boot's insert no-ops and the backfill is
skipped, regardless of what the per-user flags look like now. General
lesson: any one-time rollout that touches an authorization flag (not just
ordinary data backfills) must use this pattern, since "still matches the
seed condition" and "was never touched since" are different properties.

Durability of the marker is necessary but not sufficient: naively claiming it
on the very first call, no matter what that call found, reintroduces the
same lockout risk one boot earlier. On a fresh database the qualifying rows
(e.g. the first admin account) may not exist yet at boot time — because
demo/initial-user seeding is disabled in that environment, hasn't run yet,
or failed — and if that first call claims the marker anyway, the eventual
first qualifying row is excluded forever with no owner/admin left to grant
the flag manually afterward. Sequencing the call to run *after* the
provisioning step it depends on narrows the race but does not close it
(seeding can still be disabled or fail). The robust fix is retry-until-success:
only claim the marker when the attempt actually accomplished something (it
updated ≥1 row) or the desired end state already holds (e.g. an owner
already exists) — otherwise leave the marker unclaimed and let the next
boot's call retry for free. This turns "exactly once, whenever first
invoked" into "exactly once, the first time it can actually succeed," which
is the only version that has no permanent-lockout window.

## "Can't go below N" invariants need a locked read, not read-then-write

An invariant like "never revoke the last remaining owner" enforced as a
plain `SELECT count(...)` followed by a separate `UPDATE` is a TOCTOU race:
two concurrent revokes against two different rows can each observe the same
safe count and both proceed, leaving zero. Fix: wrap the check-and-write in
one transaction, and replace the count with a locked row read
(`SELECT id ... WHERE <condition> FOR UPDATE`, counting the returned rows in
application code — Postgres doesn't allow combining `FOR UPDATE` with an
aggregate `count()`). The second transaction then blocks until the first
commits and re-evaluates the condition against post-commit data before it's
allowed to proceed.

## Existing-test fixtures break silently when you gate a previously-open route

Retrofitting `requireCompanyOwner` (or any new hard gate) onto a route that
many *unrelated* test suites already call with a plain admin fixture breaks
all of them at once with 403s that look unrelated to your change. Grep every
test file for the newly-gated path strings before declaring done, not just
the files you wrote for the new feature — a healthy handful of pre-existing
suites across unrelated feature areas can share one admin fixture that now
needs the new flag to stay green.

## A delegable "manage this module" permission must not let the caller set a MORE privileged field than the permission itself grants

Making an admin-only action delegable to another role via the permission
matrix (e.g. letting `site_manager`/`dispatcher` create personnel records)
is safe only if every field the resulting write accepts is scoped to what
that permission is supposed to control. A user-creation endpoint that (once
gated by the new, delegable permission instead of `admin`-only) still
accepts a caller-supplied account `role` with no allowlist is a privilege
escalation: any role granted the "manage personnel" permission can then
create a brand-new `admin` (or other privileged-role) account for
themselves or a collaborator, bypassing the permission matrix and the
owner flag entirely. Fix: separate "may this caller use this endpoint at
all" (the permission-matrix check) from "which values may this caller set
once inside" — a non-admin caller through a delegated permission must be
restricted to the unprivileged default value for any field that itself
encodes privilege (role, admin flags, etc.); only an actual admin-role
caller may set a privileged value, regardless of what the matrix has
delegated. General lesson: whenever a previously admin-only route becomes
delegable to other roles, re-audit its full request body — not just the
route's own gate — for fields whose value grants privilege beyond the
specific action the permission was meant to scope.

## Extending a toggle to sibling routes: match role-sets exactly, don't average them

When a later task widens a permission key from "one representative route" to
"every CRUD/action route in that module," convert a given route to
`requirePermission(key)` ONLY when that route's current hardcoded role-gate
middleware allows the *exact same role set* as the key's `defaultAllowedRoles`
(e.g. `requireAdminOrSiteManager` ⇄ a key defaulting to `[admin, site_manager]`).
If the current gate is a three-role set (like `requireSchedulingStaff`:
admin+dispatcher+site_manager) or stricter/broader than every existing key,
leave it hardcoded rather than picking the "closest" key — silently
loosening or narrowing a route's default access is exactly the regression
this kind of task must avoid. Flag the mismatched routes as a follow-up task
(propose a new key) instead of forcing a fit.

For a route that mixes self-service and "manage someone else" (e.g. an
employee edit endpoint editable by both the owner of the record and an
admin), don't swap the outer middleware at all — replace the inline
role-name check with `isRoleAllowed(key, role)` so self-edit stays always
allowed regardless of the toggle, while only the "act on someone else"
branch becomes permission-gated.

Adding any new export to the portal's auth module breaks every existing
`vi.mock("@/lib/auth", ...)` factory that only listed `useAuth` (the new hook
comes back undefined and the component throws) — grep for that mock and
extend each factory in the same change.

## Running the full api-server test suite in a time-boxed shell

`artifacts/api-server` forces `fileParallelism:false` + `singleFork` (shared
dev DB — see the existing `admin-grid-invoice-sync-flake` memory), so a full
`pnpm test` run across ~100 files can exceed a single tool-call timeout.
`vitest run --shard=<i>/<N>` splits the suite into N sequential batches that
each fit the time budget, still respecting the single-DB serial constraint
within each shard — use it instead of trying to raise the timeout or
parallelize.
