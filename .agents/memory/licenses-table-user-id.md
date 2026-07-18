---
name: licenses.employee_id stores user IDs
description: The licenses table's employee_id column references users.id, NOT employees.id — joins via the employees table silently return nothing.
---

**Rule:** `licenses.employee_id` is a FK to `users(id)` despite its name. All eligibility/clock-in checks compare it to the JWT `userId` directly.

**Why:** Joining `licenses → employees.id → users` looks correct and runs without error but returns zero rows, making accounts appear unlicensed. Verified via `pg_constraint` (confrelid = users).

**How to apply:** Any query, seed, or backfill touching licenses must use the user's `users.id`. Same trap risk anywhere a `*_employee_id` column exists — check the FK, not the name.

**Related data prerequisite:** fresh/dev DBs seed demo users with ZERO licenses and ZERO `site_managers` rows, so clock-in, shift claim, and all site-manager flows fail on data (not code) until an admin assigns sites and licenses exist. Dev DB now has: lead@ + officer@ each holding a level-2 license, and lead@ managing "Demo Managed Site (dev smoke)".
