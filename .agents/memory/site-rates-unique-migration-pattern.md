---
name: site_rates unique constraint two-deploy pattern
description: When a unique constraint can't be added via Replit migration due to existing prod duplicate data, use a boot backfill + two-deploy workaround.
---

Replit's deployment migration validator runs the Drizzle-generated SQL against the production DB **before** the build step. If prod has duplicate rows, `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE` fails and the deploy aborts — there is no way to inject a pre-migration cleanup step.

**The two-deploy pattern:**

**Deploy 1:**
1. Remove the `.unique(...)` from the Drizzle table definition (so the migration validator has nothing to try).
2. Drop the constraint from dev DB (`ALTER TABLE ... DROP CONSTRAINT IF EXISTS ...`) so schema-drift passes.
3. Add a boot backfill that: (a) deduplicates the rows, then (b) creates the constraint via a `DO $$ IF NOT EXISTS ... ALTER TABLE ... ADD CONSTRAINT` block — this produces a `pg_constraint` entry that drizzle-kit recognises on the next deploy.
4. Wire the backfill in `index.ts`. Deploy → migration is a no-op → server boots → constraint created in prod.

**Deploy 2 (after prod first-boot):**
5. Re-add `.unique(...)` to the Drizzle schema.
6. `db push` on dev (re-creates constraint locally, no duplicates exist).
7. Redeploy → drizzle-kit introspects prod, sees `pg_constraint` already exists, emits no SQL → deploy succeeds.

**Why use `ALTER TABLE ... ADD CONSTRAINT` (not `CREATE UNIQUE INDEX`) in the backfill:**
PostgreSQL distinguishes between a bare unique INDEX (in `pg_indexes` only) and a UNIQUE CONSTRAINT (in both `pg_constraint` and `pg_indexes`). Drizzle-kit checks `pg_constraint` when matching `.unique()` definitions. Using `CREATE UNIQUE INDEX` would not be recognised in Deploy 2, causing drizzle-kit to try `ALTER TABLE ... ADD CONSTRAINT` again (which fails because an index with that name already exists).

**Key invariant:** the constraint name in the DO block must exactly match the name in the Drizzle schema (`unique("site_rates_site_level_uniq")`).
