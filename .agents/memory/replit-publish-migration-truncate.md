---
name: Replit publish migration + startup DDL caused the July 2026 prod wipe
description: Root cause of the July 18 2026 production wipe of shifts/shift_assignments/site_rates/time_entries, and the rules that prevent a repeat.
---

## What happened (July 18 2026, ~03:04 UTC)

During a publish, Replit's DB-migration step wiped 4 prod tables: `site_rates`,
`shifts`, `shift_assignments`, `time_entries`. Recovery required a Replit-support
PITR restore (small activity window lost).

**Mechanism** (footprint matches exactly): the publish flow introspects the DEV
database and diffs it against PROD — it does NOT read the drizzle schema files.
Dev had `site_rates_site_level_uniq UNIQUE(site_id, license_level)`; prod had the
old 3-column `(site_id, license_level, label)` constraint plus duplicate
(site_id, license_level) rows. The generated ADD CONSTRAINT could not apply, and
the resolution truncated `site_rates` — TRUNCATE … CASCADE follows FKs:
`shifts.site_rate_id → site_rates`, then `shift_assignments` + `time_entries`
(FK → shifts). A boot-time "self-healing" DELETE+ALTER in the server entrypoint
created a second writer racing the same constraint at publish time.

## Rules

- **Never put DDL in server startup** (ALTER TABLE / CREATE TABLE / ADD
  CONSTRAINT "self-healing"). Replit's publish flow owns prod schema; startup DDL
  creates a two-writer conflict. Boot-time DATA backfills (UPDATE/INSERT) remain
  fine.
- **Removing `.unique()` from the drizzle schema does NOT protect a publish** —
  the publish diff is dev-DB vs prod-DB, so a constraint present in the dev DB
  is still in the diff.
- **Before any publish that adds a unique constraint**: make prod already
  satisfy it (dedupe rows) and ideally already HAVE the identically-named
  constraint, so the publish diff for that table is empty. Prod writes go
  through the prod Database pane SQL (user-run) or an admin UI action — the
  agent's executeSql is read-only on prod.
- **Adding a unique constraint to a populated table is the single most
  dangerous migration** in this stack — treat any such publish as an incident
  risk and verify prod data first via read-only queries.

## How to check redeploy safety

Diff dev vs prod before publishing: `information_schema.columns`,
`pg_constraint` (via `pg_get_constraintdef`), `pg_indexes`. Purely additive
diffs (new tables, nullable/defaulted columns, dropped constraints) are safe;
ADD CONSTRAINT UNIQUE on populated tables is the red flag.
