---
name: Officer time-entry correction history
description: How officer time-entry change history is sourced and why it filters on entryId alone (not action)
---

Officer time-entry correction history (the "Edited" badge + change dialog on the
Payroll Board) is sourced from `audit_logs` filtered by `metadata->>'entryId'`,
NOT by audit `action`.

**Why:** officer time entries are admin-corrected through TWO different routes that
each emit a DIFFERENT global-middleware audit action — `table.write` for the
generic grid edit (`PUT /admin/tables/time_entries/:id`) and `time_entries.write`
for the clock-out fix (`PATCH /time-entries/:id/clock-out`). There is no dedicated
custom action like subcontractor entries have (`subcontractor_entry_edit`). So
filtering by action would miss half the corrections.

**How to apply:** any new admin path that edits a time entry must (1) stamp the
`last_edited_by_user_id / _email / _at` columns on `time_entries`, and (2) set
`res.locals.auditMetadata = buildTimeEntryAuditMetadata(id, before, after)` (from
`lib/timeEntryAudit.ts`) so the global audit middleware persists before/after
keyed by entry id. The before/after snapshot covers only
{clockInTime, clockOutTime, hoursWorked, payRateOverride, notes}; if you make a
new field user-editable, add it to `timeEntrySnapshot` AND the UI `HISTORY_FIELDS`
in PayrollBoard.tsx, or the change won't appear in history.
