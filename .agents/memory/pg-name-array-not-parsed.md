---
name: pg name[] arrays returned as strings
description: node-postgres does not parse name[]/array_agg(name) results into JS arrays
---

When a query returns a Postgres `name[]` column (e.g. `array_agg(att.attname)`
over `pg_attribute.attname`, which has type `name`), the `pg` (node-postgres)
driver has no array parser registered for the `name` element type, so the row
value comes back as a raw Postgres array **string** like `"{employee_id}"`,
not a JS `string[]`. Calling `.join`/`.map` on it throws
`localCols.join is not a function`.

**Fix:** cast the element to a parsed type inside the aggregate —
`array_agg(att.attname::text ORDER BY ...)` returns `text[]`, which the driver
*does* parse into a JS array.

**Why:** surfaced building the foreign-key dimension of the schema-drift gate
(`scripts/src/check-schema-drift.ts`), which array_aggs constrained column
names out of `pg_constraint` / `pg_attribute`.

**How to apply:** any pg_catalog introspection that array_aggs `name`-typed
columns (attname, relname, conname, nspname, enumlabel, …) must cast to
`::text` if you intend to consume the result as a JS array.
