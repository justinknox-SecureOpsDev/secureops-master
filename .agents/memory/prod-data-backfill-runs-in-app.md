---
name: Production data backfills must run inside the live app
description: Why agent-side executeSql backfills only fix dev, and how to actually repair production data
---

# Production data backfills must run inside the live app

The agent's `executeSql` (code_execution sandbox / database skill) writes only to the
**development** database. `environment: "production"` is **READ-ONLY** (SELECT only).
The deployed app runs against a **separate** production database — confirmed by
differing row counts (e.g. dev `total_users=285` vs prod `326`).

So a data backfill run from the agent loop fixes dev and silently leaves prod
untouched. The published app keeps reading the un-repaired prod rows.

**Why:** an earlier "production phone backfill" actually only hit dev; prod still had
6 valid / 320 blank `users.phoneNumber` while dev showed 231 valid. The user noticed
the live user profiles still had no phone numbers.

**How to apply:** to repair existing production DATA (not schema), put a one-time,
idempotent backfill INSIDE the app's boot sequence — next to `seedDemoUsers` /
`ensureEmployeesRowsForAllUsers` in `artifacts/api-server/src/index.ts`, fired async
with `.catch` so a failure can't sink startup. Then the user **republishes** and the
fix runs against prod on boot. Make it idempotent (narrow WHERE so repaired rows
re-select 0), guard the UPDATE so it can't clobber a value fixed concurrently between
SELECT and UPDATE, and only log when it actually changed rows (junk/unnormalizable
rows stay candidates forever otherwise → boot-log noise).

Schema changes are different: those go through the Publish flow (dev schema diffed to
prod at publish time), never custom migration scripts or startup DDL.
