import { pgTable, text, uuid, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Admin-minted, no-login share link for a single officer profile. The
 * intended recipient is typically a client / site contact who needs to
 * see a sanitized officer summary (with bank + SSN already masked) but
 * does not have a portal account. Each link is high-entropy, revocable,
 * and expires by default in 30 days.
 *
 * Mirrors `incident_share_links` so the two surfaces share their public
 * UX, rate-limiting, and revocation patterns.
 */
export const employeeShareLinksTable = pgTable("employee_share_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The officer whose profile is being shared. `employee` userId, not
  // an `employees.id` — matches how the profile PDF is keyed.
  employeeUserId: uuid("employee_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdBy: uuid("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Free-text label so admins can remember who they sent the link to
  // (e.g. "Acme Mall — Janet Park"). Never shown to the recipient.
  recipientLabel: text("recipient_label"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  employeeIdx: index("employee_share_links_employee_idx").on(t.employeeUserId),
  expiresIdx: index("employee_share_links_expires_idx").on(t.expiresAt),
}));

export type EmployeeShareLink = typeof employeeShareLinksTable.$inferSelect;
