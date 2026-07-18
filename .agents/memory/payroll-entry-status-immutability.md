---
name: payroll_entries non-pending rows are immutable
description: Any write/upsert path touching payroll_entries must gate on status='pending'
---

Rule: `payroll_entries` rows in `archived`, `processed`, or `paid` status are point-in-time financial snapshots and must never be rewritten by recompute paths.

**Why:** `/payroll/generate` upserts by (employee, site, periodStart) with `onConflictDoUpdate`; without a status gate a re-generate silently overwrote archived snapshot totals (and would have rewritten processed/paid records) while leaving the status intact — corrupting the audit trail the UI promises.

**How to apply:** any new insert/upsert/update path on `payroll_entries` (board actions, generate, apply-rate, imports) must include a status guard — drizzle `onConflictDoUpdate({ ..., setWhere: eq(status,'pending') })` or an explicit `WHERE status='pending'` — and skip (not error-rewrite) non-pending rows. Archive/unarchive are the only paths allowed to transition into/out of `archived`.
