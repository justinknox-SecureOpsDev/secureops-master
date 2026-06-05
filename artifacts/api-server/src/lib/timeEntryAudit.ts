// Shared helpers for recording officer time-entry corrections to the audit log.
//
// Officer time entries can be admin-corrected from two surfaces:
//   - PATCH /time-entries/:id/clock-out  (force / fix a missing clock-out)
//   - PUT  /admin/tables/time_entries/:id (generic admin grid edit)
//
// Both routes snapshot the entry's payroll-relevant fields before/after the
// change and stash them on `res.locals.auditMetadata`, which the global
// auditLogMiddleware persists into `audit_logs.metadata`. Reviewers then open a
// per-entry change history by filtering audit logs on `metadata->>'entryId'`.
// This mirrors the subcontractor time-entry correction history exactly.

export type TimeEntrySnapshot = {
  clockInTime: string | null;
  clockOutTime: string | null;
  hoursWorked: string | null;
  payRateOverride: string | null;
  notes: string | null;
};

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Capture the editable, payroll-relevant fields of a time-entry row. */
export function timeEntrySnapshot(row: {
  clockInTime?: Date | string | null;
  clockOutTime?: Date | string | null;
  hoursWorked?: string | null;
  payRateOverride?: string | null;
  notes?: string | null;
}): TimeEntrySnapshot {
  return {
    clockInTime: toIso(row.clockInTime),
    clockOutTime: toIso(row.clockOutTime),
    hoursWorked: row.hoursWorked ?? null,
    payRateOverride: row.payRateOverride ?? null,
    notes: row.notes ?? null,
  };
}

/** Build the audit metadata payload for an officer time-entry correction. */
export function buildTimeEntryAuditMetadata(
  entryId: string,
  before: TimeEntrySnapshot,
  after: TimeEntrySnapshot,
): { entryId: string; changedFields: string[]; before: TimeEntrySnapshot; after: TimeEntrySnapshot } {
  const changedFields = (Object.keys(before) as (keyof TimeEntrySnapshot)[]).filter(
    (k) => before[k] !== after[k],
  );
  return { entryId, changedFields, before, after };
}
