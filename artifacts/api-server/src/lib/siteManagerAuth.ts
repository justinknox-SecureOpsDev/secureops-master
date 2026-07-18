import { and, eq, inArray } from "drizzle-orm";
import type { Response } from "express";
import { db, siteManagersTable } from "@workspace/db";

/**
 * Site-manager per-site scoping helpers.
 *
 * The `site_manager` role is a scheduling supervisor whose authority is limited
 * to the specific sites they are assigned to (rows in `site_managers`). Admins
 * (and dispatchers, on the shared scheduling surfaces) are GLOBAL roles and
 * bypass every check here unchanged — these helpers exist purely to confine the
 * site_manager role. Callers must still apply the coarse role gate
 * (`requireAdminOrSiteManager` / `requireSchedulingStaff`) first; these helpers
 * answer the narrower question "may THIS site manager act on THIS site?".
 *
 * All scoping joins through `site_id`, never a client-supplied list, so a
 * manager cannot reach another site's shifts/assignments/time-entries by id
 * (no IDOR).
 */

/** All site IDs a given user manages. Empty array = manages nothing. */
export async function getManagedSiteIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ siteId: siteManagersTable.siteId })
    .from(siteManagersTable)
    .where(eq(siteManagersTable.userId, userId));
  return rows.map((r) => r.siteId);
}

/** True iff the user is assigned as a manager of the given site. */
export async function managesSite(userId: string, siteId: string | null | undefined): Promise<boolean> {
  if (!siteId) return false;
  const rows = await db
    .select({ siteId: siteManagersTable.siteId })
    .from(siteManagersTable)
    .where(and(eq(siteManagersTable.userId, userId), eq(siteManagersTable.siteId, siteId)))
    .limit(1);
  return rows.length > 0;
}

/** All user IDs who manage the given site (e.g. notification recipients). */
export async function getManagerUserIdsForSite(siteId: string | null | undefined): Promise<string[]> {
  if (!siteId) return [];
  const rows = await db
    .select({ userId: siteManagersTable.userId })
    .from(siteManagersTable)
    .where(eq(siteManagersTable.siteId, siteId));
  return rows.map((r) => r.userId);
}

/** Manager user IDs for any of the given sites (deduped). */
export async function getManagerUserIdsForSites(siteIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(siteIds.filter((s): s is string => !!s)));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ userId: siteManagersTable.userId })
    .from(siteManagersTable)
    .where(inArray(siteManagersTable.siteId, ids));
  return Array.from(new Set(rows.map((r) => r.userId)));
}

/**
 * Authorization gate for acting on a specific site. Returns true if the caller
 * may proceed; otherwise writes a 403 response and returns false.
 *
 *   - admin / dispatcher: always allowed (global scheduling roles, unchanged).
 *   - site_manager: allowed only if assigned to `siteId`.
 *   - anyone else: denied (fail closed if mis-wired upstream).
 *
 * `siteId` may be null/undefined (e.g. a site-less shift). A non-global caller
 * is denied in that case, since an unscopable resource cannot be proven to be
 * within the manager's remit.
 */
export async function assertCanManageSite(
  res: Response,
  user: { userId: string; role: string },
  siteId: string | null | undefined,
): Promise<boolean> {
  if (user.role === "admin" || user.role === "dispatcher") return true;
  if (user.role !== "site_manager") {
    res.status(403).json({ error: "Forbidden", message: "Site manager access required" });
    return false;
  }
  if (await managesSite(user.userId, siteId)) return true;
  res.status(403).json({
    error: "Forbidden",
    message: "You can only manage sites you are assigned to.",
  });
  return false;
}
