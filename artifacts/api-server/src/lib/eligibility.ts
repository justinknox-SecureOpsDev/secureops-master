import { and, eq, gte, sql } from "drizzle-orm";
import { db, licensesTable, employeesTable, usersTable } from "@workspace/db";

/**
 * Eligibility / capability-level model.
 *
 * Shifts declare a minimum `requiredLicenseLevel`. The hierarchy is:
 *   1 = Support (no security licence required)
 *   2 = L2 Unarmed
 *   3 = L3 Armed
 *   4 = L4 / PPO
 * Higher levels cover lower ones (an L4 officer can work an L2 or a support
 * shift).
 *
 * Unarmed work (level <= 2) is open to EVERY employee. Level 2 is the
 * eligibility floor (`BASE_ELIGIBILITY_LEVEL`), so any employee can both SEE
 * and ACCEPT level-1 and level-2 shifts regardless of whether they hold a
 * licence. Armed (3) and L4/PPO (4) shifts still require the officer to
 * actually hold an unexpired licence at that level or higher.
 *
 * The floor applies to EMPLOYEES only — users whose `role` is a worker role
 * (`employee` or `site_manager`). Non-worker accounts (`admin` / `dispatcher`
 * / `client`) are NOT shift-work candidates, so they get no floor and read as
 * effective 0 — otherwise the floor would silently let a non-employee claim or
 * be assigned to unarmed shifts (the claim route is bare `requireAuth`, and
 * manual/scheduler assignment takes an arbitrary user id). Role — not the
 * presence of an `employees` row — is the canonical worker signal here (it is
 * what every employee-scoped query, e.g. dispatch assign-nearest, filters on).
 *
 * An employee's *effective* level is therefore:
 *   GREATEST(highest unexpired licence level, position baseline, BASE_ELIGIBILITY_LEVEL)
 * The position baseline (support_staff -> 1) is now subsumed by the level-2
 * floor but kept for clarity / future tuning.
 *
 * IMPORTANT: the effective level is an ELIGIBILITY figure, NOT a statement of
 * which licence an officer holds. A no-licence employee has an effective level
 * of 2 (they may take unarmed work) yet holds no licence. Surfaces that report
 * a *held* licence (officer profile, PDFs, the licence grid) must read the
 * licence rows directly — never this value.
 *
 * Note: `licenses.employee_id` and `employees.user_id` both reference
 * `users.id`, so every helper here is keyed on the user id.
 */

/**
 * Minimum effective eligibility level for any employee. Unarmed work
 * (level <= 2) is open to all, so the effective level never drops below this.
 */
export const BASE_ELIGIBILITY_LEVEL = 2;

export function positionBaselineLevel(position: string | null | undefined): number {
  return position === "support_staff" ? 1 : 0;
}

/** Roles that represent actual shift workers (and so receive the level-2 floor). */
export function isWorkerRole(role: string | null | undefined): boolean {
  return role === "employee" || role === "site_manager";
}

/**
 * The set of roles that represent actual shift workers, for use in `inArray`
 * SQL filters when targeting the worker pool (e.g. shift-available / vacancy
 * notification broadcasts). The SQL-level mirror of `isWorkerRole` — site
 * managers are workers too, so they must be included anywhere employees are
 * notified or listed as eligible.
 */
export const WORKER_ROLES = ["employee", "site_manager"] as const;

/**
 * Highest effective capability level for a single user:
 * max(highest unexpired licence level, position baseline, BASE_ELIGIBILITY_LEVEL).
 * The BASE_ELIGIBILITY_LEVEL floor is applied ONLY when the user is a worker
 * (role `employee` / `site_manager`), so every employee is eligible for unarmed
 * (level <= 2) shifts while non-worker accounts (admin / dispatcher / client)
 * stay at their real level (0) and cannot claim / be assigned to unarmed shifts.
 */
export async function getEffectiveLevel(userId: string): Promise<number> {
  const [licRows, empRows, userRows] = await Promise.all([
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
    db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
  ]);
  let max = 0;
  for (const r of licRows) if (r.level != null && r.level > max) max = r.level;
  // The level-2 floor is an EMPLOYEE benefit. A non-worker account (admin /
  // dispatcher / client) is not a shift candidate, so it gets no floor.
  const floor = isWorkerRole(userRows[0]?.role) ? BASE_ELIGIBILITY_LEVEL : 0;
  return Math.max(max, positionBaselineLevel(empRows[0]?.position), floor);
}

/**
 * SQL fragment computing the effective level inside a query that is grouped
 * by `users.id` and has BOTH `licensesTable` and `employeesTable` left-joined
 * onto the user (licenses.employee_id = users.id, employees.user_id = users.id).
 * Floored at BASE_ELIGIBILITY_LEVEL so unarmed work is open to every employee.
 */
export const effectiveLevelSql = sql<number>`greatest(
  coalesce(max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date), 0),
  coalesce(max(case when ${employeesTable.position} = 'support_staff' then 1 else 0 end), 0),
  ${sql.raw(String(BASE_ELIGIBILITY_LEVEL))}
)`;
