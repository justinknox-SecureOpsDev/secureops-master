---
name: Prod schema has no auto-migrate
description: VM deploy never runs db push; a schema-adding change shipped without applying the column to prod breaks login.
---

The Reserved-VM deploy (`.replit` `build = build:vm`, postBuild `pnpm store prune`)
runs **no** `drizzle-kit push` / migration step, and the api-server has **no**
boot-time `ADD COLUMN IF NOT EXISTS` guard. Schema reaches a prod customer DB
**only** via a manual `pnpm --filter @workspace/db run push` against that DB.

**Why it bites:** Drizzle `select().from(usersTable)` (e.g. `userPayload` on every
login/me) reads the *full* row. If code that references a new column is republished
before the column exists in prod, that SELECT throws and **prod login goes down** —
not a soft-degrade.

**How to apply:** any schema-adding change must apply the column to the prod DB
(db push against prod, or the database skill's "push dev to prod" path) **before or
together with** the VM republish — never republish first. Dev can use a raw
idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` when `db push` is unsafe
(e.g. it wants to drop control_plane_* tables that share the dev DB but live in a
separate DB in prod). In a prod customer DB those control_plane tables are absent,
so `db push` there is clean.
