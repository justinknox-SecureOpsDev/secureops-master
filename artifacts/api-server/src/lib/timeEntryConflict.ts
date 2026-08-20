/**
 * Detection of the database-level "one open time entry per officer" conflict.
 *
 * `time_entries` carries a partial unique index —
 *   UNIQUE (employee_id) WHERE clock_out_time IS NULL
 * — as the safety net behind every clock-in path's application-level guard
 * (row lock on the officer's `users` row + re-check before insert). If a path
 * ever misses that guard, or two writers race outside a shared lock, Postgres
 * rejects the second insert with a 23505 unique violation instead of silently
 * creating a duplicate open row.
 *
 * That rejection is a *user-level* conflict ("you're already clocked in"), not
 * a server fault, so every clock-in path must map it onto the same response it
 * already returns when its own pre-check finds an open entry — never a 500.
 */

export const ONE_OPEN_TIME_ENTRY_INDEX = "time_entries_one_open_per_employee_uniq";

/**
 * True when `err` is the Postgres unique violation raised by the
 * one-open-entry-per-officer partial index.
 *
 * Matches on the constraint name so an unrelated 23505 on the same table
 * (e.g. the `(external_source, external_id)` scheduler index) still surfaces
 * as a real error rather than being mislabelled "already clocked in".
 */
export function isOpenTimeEntryConflict(err: unknown): boolean {
  // Drizzle wraps driver errors in a `DrizzleQueryError` ("Failed query: …")
  // and hangs the real pg error off `cause`, so walk the chain rather than
  // inspecting only the top-level object.
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof e === "object") {
      if (e.code === "23505") {
        if (typeof e.constraint === "string") {
          if (e.constraint === ONE_OPEN_TIME_ENTRY_INDEX) return true;
        } else if (typeof e.message === "string" && e.message.includes(ONE_OPEN_TIME_ENTRY_INDEX)) {
          // Some drivers/wrappers drop `constraint`; fall back to message text.
          return true;
        }
      }
      current = e.cause;
      continue;
    }
    break;
  }
  return false;
}
