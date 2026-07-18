import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/**
 * Many-to-many link of Site Managers to the sites they manage.
 *
 * A Site Manager (users.role = "site_manager") supervises one or more sites:
 * they create/edit shifts, approve shift claims, and approve time entries —
 * but ONLY for the sites listed here. A site may have multiple managers and a
 * manager may cover multiple sites.
 *
 * This table is the single source of truth for that site-scoped authorization
 * (see artifacts/api-server/src/lib/siteManagerAuthz.ts) and for routing
 * site-manager notifications (a new shift is created at their site, or a shift
 * at their site receives a pending claim).
 *
 * Rows cascade-delete with their site or user, so removing a site or deleting
 * a user automatically revokes the assignment.
 */
export const siteManagersTable = pgTable("site_managers", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  // Admin who made the assignment (audit trail). Null if the assigner's
  // account is later deleted.
  assignedBy: uuid("assigned_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  siteUserUnique: uniqueIndex("site_managers_site_user_unique").on(t.siteId, t.userId),
  siteIdx: index("site_managers_site_idx").on(t.siteId),
  userIdx: index("site_managers_user_idx").on(t.userId),
}));

export type SiteManager = typeof siteManagersTable.$inferSelect;
