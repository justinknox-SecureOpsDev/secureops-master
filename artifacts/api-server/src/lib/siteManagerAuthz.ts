import type { Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, siteManagersTable, usersTable } from "@workspace/db";

/**
 * Central, server-side authorization for the Site Manager role.
 *
 * A Site Manager (`users.role === "site_manager"`) is a mobile-only site
 * supervisor whose powers — creating/editing shifts, approving shift claims,
 * approving time entries — are scoped to the specific sites they have been
 * assigned to in the `site_managers` join table. Admins have global access and
 * every other role has none. This module is the single source of truth for
 * that scope so every privileged route enforces it identically; never inline a
 * role/site check in a handler.
 *
 * The `requireAdminOrSiteManager` middleware only proves the caller holds the
 * role — the per-site boundary MUST additionally be enforced here on the exact
 * site each request touches (a manager of site A must not act on site B).
 */

export type AuthUserLike = { userId: string; role: string };

/** All site IDs a user manages. Empty for non-managers (admins included — an
 * admin's reach is "all sites", which callers handle explicitly rather than by
 * enumerating this list). */
export async function getManagedSiteIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ siteId: siteManagersTable.siteId })
    .from(siteManagersTable)
    .where(eq(siteManagersTable.userId, userId));
  return rows.map((r) => r.siteId);
}

/** Every user assigned to manage a given site (used to fan out notifications).
 * Filtered to live managers — a join row whose user has since been downgraded
 * out of the `site_manager` role or deactivated must NOT receive site alerts,
 * so we re-check role+status here rather than trusting the join row alone. */
export async function getSiteManagerUserIds(siteId: string): Promise<string[]> {
  return (await getSiteManagerUserIdsForSites([siteId])).get(siteId) ?? [];
}

/** Bulk form of getSiteManagerUserIds: siteId → live manager user ids, in one
 * query. Every site asked for gets an entry (empty array if it has no live
 * managers) so callers can look up without a null check. */
export async function getSiteManagerUserIdsForSites(
  siteIds: string[],
): Promise<Map<string, string[]>> {
  const bySite = new Map<string, string[]>(siteIds.map((id) => [id, []]));
  if (siteIds.length === 0) return bySite;
  const rows = await db
    .select({ siteId: siteManagersTable.siteId, userId: siteManagersTable.userId })
    .from(siteManagersTable)
    .innerJoin(usersTable, eq(usersTable.id, siteManagersTable.userId))
    .where(
      and(
        inArray(siteManagersTable.siteId, [...new Set(siteIds)]),
        eq(usersTable.role, "site_manager"),
        eq(usersTable.status, "active"),
      ),
    );
  for (const r of rows) bySite.get(r.siteId)?.push(r.userId);
  return bySite;
}

/**
 * Whether `user` may act on `siteId`. Admins → always. Site managers → only if
 * assigned to that site. A null/undefined site (e.g. a shift with no site) is
 * never manageable by a site manager. Everyone else → never.
 */
export async function canManageSite(
  user: AuthUserLike,
  siteId: string | null | undefined,
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role !== "site_manager") return false;
  if (!siteId) return false;
  const [row] = await db
    .select({ id: siteManagersTable.id })
    .from(siteManagersTable)
    .where(and(eq(siteManagersTable.userId, user.userId), eq(siteManagersTable.siteId, siteId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Guard helper: returns true if `user` may act on `siteId`; otherwise sends a
 * 403 on `res` and returns false. Callers MUST `return` when this returns
 * false (the response is already written).
 */
export async function assertCanManageSite(
  user: AuthUserLike,
  siteId: string | null | undefined,
  res: Response,
): Promise<boolean> {
  const ok = await canManageSite(user, siteId);
  if (!ok) {
    res.status(403).json({ error: "Forbidden", message: "You do not manage this site" });
  }
  return ok;
}
