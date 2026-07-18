---
name: Replit startup DDL is prohibited and causes data loss
description: Never add ALTER TABLE / CREATE TABLE / startup-time schema DDL to the server entrypoint. Replit manages prod schema via the Publish flow; startup DDL bypasses it and caused production data loss.
---

Replit's publish flow owns all production schema changes. The flow:
1. Introspects dev DB and prod DB
2. Diffs them
3. Shows renames in Publish UI (unanswered renames → DROP + ADD → data loss)
4. Applies the SQL to prod as part of publish

**What the agent must NOT do:**
- Run `ALTER TABLE`, `CREATE TABLE IF NOT EXISTS`, or any DDL at server startup ("self-healing production")
- Run `drizzle-kit push` against production directly
- Write custom migration scripts targeting production
- Add schema mutation to the deploy build command

**What happened when this rule was broken:**
- A startup-time `DELETE FROM site_rates WHERE ...` + `ALTER TABLE site_rates ADD CONSTRAINT` was added to `seedDemoUsers.ts` to work around a migration conflict
- The Replit publish flow also applied its own schema diff SQL when the app was published
- The result was production data loss: shifts (0), shift_assignments (0), site_rates (0), time_entries (mostly gone) — while payroll, invoices, users, sites remained intact
- Recovery required contacting Replit support for a database restore

**The correct pattern for schema changes:**
1. Change the Drizzle schema source of truth (`lib/db/src/schema/`)
2. Run `pnpm --filter @workspace/db run push` on DEV only to apply to dev DB
3. Verify the feature works in dev
4. Tell the user to re-publish — Replit's publish flow applies the diff to prod
5. If the change involves a rename, warn the user they will see a confirmation prompt in the Publish UI and must answer it correctly

**The correct pattern for a unique constraint with pre-existing duplicates:**
- Do NOT add startup DDL
- Instead: before publishing, DELETE the duplicate rows from prod DB via Replit support or a one-time admin script route, THEN publish — the constraint addition will succeed cleanly
- Or: use the Publish UI's rename-confirmation to handle it
- The two-deploy workaround (remove unique → publish → add startup DDL → publish) was wrong because the startup DDL ran DELETE against prod and the publish flow applied independent DDL creating a conflict

**Why:**
Replit's publish flow is the ONLY supported path for prod schema changes. Startup DDL runs AFTER the publish-flow DDL and creates a two-writer situation. The interaction between the two caused the data loss (exact SQL sequence unrecoverable without Replit support logs, but the pattern is clear).
