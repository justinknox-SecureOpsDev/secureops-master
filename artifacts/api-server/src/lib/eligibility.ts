import { and, eq, gte, sql } from "drizzle-orm";
import { db, licensesTable, employeesTable } from "@workspace/db";

/**
 * Eligibility / capability-level model.
 *
 * Shifts declare a minimum `requiredLicenseLevel`. The hierarchy is:
 *   1 = Support (no security licence required)
 *   2 = L2 Unarmed
 *   3 = L3 Armed
 *   4 = L4 / PPO
 * Higher levels cover lower ones (an L4 officer can work an L2 or a support
 * shift). An officer's *effective* level is the GREATER of their highest
 * unexpired licence level and a baseline derived from their `position`:
 *   - position 'support_staff' → baseline 1 (can work level-1 support shifts
 *     even though they hold no licence)
 *   - everyone else            → baseline 0 (must hold a licence to work)
 *
 * Note: `licenses.employee_id` and `employees.user_id` both reference
 * `users.id`, so every helper here is keyed on the user id.
 */

export function positionBaselineLevel(position: string | null | undefined): number {
  return position === "support_staff" ? 1 : 0;
}

/** Roles that represent shift workers (internal staff). */
export function isWorkerRole(role: string | null | undefined): boolean {
  return role === "employee" || role === "site_manager" || role === "dispatcher" || role === "admin";
}

/**
 * The set of roles that represent shift workers, for use in `inArray` SQL
 * filters when targeting the worker pool (e.g. profile-completeness reports,
 * shift-available / vacancy notification broadcasts). The SQL-level mirror of
 * `isWorkerRole` — ALL internal staff (employee, site manager, dispatcher,
 * admin) are workers and may work / claim / be assigned shifts.
 *
 * INVARIANT: this set must NEVER include `client` — external client-portal
 * accounts are not part of the worker pool.
 */
export const WORKER_ROLES = ["employee", "site_manager", "dispatcher", "admin"] as const;

/**
 * Highest effective capability level for a single officer:
 * max(highest unexpired licence level, position baseline).
 * Returns 0 for an officer with no licence and no support baseline.
 */
export async function getEffectiveLevel(userId: string): Promise<number> {
  const [licRows, empRows] = await Promise.all([
    db
      .select({ level: licensesTable.level })
      .from(licensesTable)
      .where(and(
        eq(licensesTable.employeeId, userId),
        gte(licensesTable.expiryDate, sql`current_date`),
      )),
    db
      .select({ position: employeesTable.position })
      .from(employeesTable)
      .where(eq(employeesTable.userId, userId))
      .limit(1),
  ]);
  let max = 0;
  for (const r of licRows) if (r.level != null && r.level > max) max = r.level;
  return Math.max(max, positionBaselineLevel(empRows[0]?.position));
}

/**
 * SQL fragment computing the effective level inside a query that is grouped
 * by `users.id` and has BOTH `licensesTable` and `employeesTable` left-joined
 * onto the user (licenses.employee_id = users.id, employees.user_id = users.id).
 */
export const effectiveLevelSql = sql<number>`greatest(
  coalesce(max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date), 0),
  coalesce(max(case when ${employeesTable.position} = 'support_staff' then 1 else 0 end), 0)
)`;
