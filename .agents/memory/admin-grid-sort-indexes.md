---
name: Admin grid sort indexes
description: Every admin-CRUD table's default sort column must have a (col, id) composite index matching the list + position ORDER BY.
---

The generic admin grid (`artifacts/api-server/src/routes/admin.ts`) orders every
list AND the `/admin/tables/:table/:id/position` deep-link by
`(sortColumn, id ASC)` — the sort column (default = each table's `orderBy` in the
`tables` registry) plus the primary-key `id` tiebreaker.

**Rule:** when you add a new table to the admin `tables` registry (or change a
table's default `orderBy`), add a composite index `(orderByColumn, id)` on that
table in `lib/db/src/schema/` and re-run `pnpm --filter @workspace/db run push`.

**Why:** without it, a table with tens of thousands of rows does a full scan +
full sort on every grid load and every position lookup. The composite index lets
both the `ORDER BY ... LIMIT/OFFSET` and the `row_number() OVER (ORDER BY ...)`
window run index-ordered. The `id` tiebreaker matters most for `date`-typed sort
columns (periodStart / expiryDate) where value ties are common; for timestamp
columns ties are rare but including id keeps ordering fully index-determined.

**How to apply:** indexes are plain ascending `(col, id)` — consistent with the
existing codebase convention. Postgres serves the default `desc` grid via
backward scan + incremental sort. All 16 registry tables were backfilled with
these indexes (e.g. `users_created_idx`, `incidents_occurred_idx`,
`licenses_expiry_idx`, `shifts_start_idx` extended to include id).
