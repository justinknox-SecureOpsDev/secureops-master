---
name: Drizzle date vs timestamp coercion
description: Drizzle pg `date` columns want ISO strings, `timestamp` columns want Date objects — coercing the wrong one breaks writes.
---

# Drizzle `date` columns take ISO strings, `timestamp` columns take Date objects

In the generic admin CRUD `coerceWrite` path, any helper that converts incoming
values to JS `Date` objects (e.g. an `applyDateCoercion`) must be applied ONLY to
Drizzle `timestamp` columns, never to `date` columns.

- `pg` `date` columns (drizzle `date(...)`) expect a plain ISO date **string**
  (`"2026-06-01"`). Passing a `Date` object throws / produces a malformed write.
- `pg` `timestamp` columns (drizzle `timestamp(...)`) expect a JS `Date` object.

**Why:** Subcontractor invoices/contracts/COIs mix both kinds — e.g.
`effectiveDate` / `expiryDate` / `startDate` / `endDate` / `issueDate` / `dueDate`
are `date`, while `approvedAt` / `paidAt` are `timestamp`. Blanket date-coercion
broke the `date` writes until coercion was restricted to the timestamp columns.

**How to apply:** When registering new tables in the admin CRUD registry, classify
each temporal column by its Drizzle type. Add only `timestamp` columns to the
date-coercion set; leave `date` columns as pass-through strings.
