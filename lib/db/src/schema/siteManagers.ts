import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/**
 * Many-to-many assignment of Site Managers to sites.
 *
 * A "site_manager"-role user gains scoped management powers (shift create/
 * edit, claim approval, time-entry approval, notifications) ONLY for the
 * sites they are assigned to here. A site can have multiple managers and a
 * manager can cover multiple sites, hence a join table rather than a single
 * FK column on `sites`.
 *
 * Both FKs cascade-delete: removing a site or a user tears down their
 * assignment rows so a manager never retains powers over a deleted site and
 * a deleted user leaves no dangling assignment.
 */
export const siteManagersTable = pgTable("site_managers", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One assignment row per (site, manager); also backs "managers of this site".
  siteUserUnique: uniqueIndex("site_managers_site_user_unique").on(t.siteId, t.userId),
  // "Which sites does this manager cover?" — the hot path for scoped authz.
  userIdx: index("site_managers_user_idx").on(t.userId),
}));

export type SiteManager = typeof siteManagersTable.$inferSelect;
