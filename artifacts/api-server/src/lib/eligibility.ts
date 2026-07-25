import { and, eq, gte, sql } from "drizzle-orm";
import { db, licensesTable } from "@workspace/db";

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
 * unexpired licence level and the universal worker baseline of 1: level 1
 * (Support) is not a licensed position, so EVERY worker — regardless of
 * position — can work level-1 shifts without holding any licence. Licences
 * only matter from level 2 upward.
 *
 * Note: `licenses.employee_id` and `employees.user_id` both reference
 * `users.id`, so every helper here is keyed on the user id.
 */

/**
 * Baseline effective level for any worker. Level 1 (Support) requires no
 * licence, so the baseline is 1 for everyone. The `position` argument is
 * kept for call-site compatibility but no longer affects the result.
 */
export function positionBaselineLevel(_position?: string | null | undefined): number {
  return 1;
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
 * max(highest unexpired licence level, worker baseline of 1).
 * Never returns less than 1 — level-1 support shifts need no licence.
 */
export async function getEffectiveLevel(userId: string): Promise<number> {
  const licRows = await db
    .select({ level: licensesTable.level })
    .from(licensesTable)
    .where(and(
      eq(licensesTable.employeeId, userId),
      gte(licensesTable.expiryDate, sql`current_date`),
    ));
  let max = 0;
  for (const r of licRows) if (r.level != null && r.level > max) max = r.level;
  return Math.max(max, positionBaselineLevel());
}

/**
 * SQL fragment computing the effective level inside a query that is grouped
 * by `users.id` and has `licensesTable` left-joined onto the user
 * (licenses.employee_id = users.id). Floors at 1 — the universal worker
 * baseline — so unlicensed workers qualify for level-1 support shifts.
 */
export const effectiveLevelSql = sql<number>`greatest(
  coalesce(max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date), 0),
  1
)`;
