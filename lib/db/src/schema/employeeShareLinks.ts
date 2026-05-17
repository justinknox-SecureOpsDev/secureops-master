import { pgTable, text, uuid, timestamp, integer, index, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-link toggle map controlling which sections of the profile are
 * visible to the recipient (both the JSON endpoint and the PDF builder
 * honour this). Defaults to every section enabled — which matches the
 * historical `redactForPublicShare` behaviour where these sections
 * were always shown and the sensitive ones (contact, banking, SSN,
 * emergency contact, references, acknowledgements) were always hidden.
 */
export type EmployeeShareVisibleSections = {
  license: boolean;
  experience: boolean;
  skills: boolean;
  uniform: boolean;
  trainingCerts: boolean;
  documents: boolean;
};

export const DEFAULT_EMPLOYEE_SHARE_SECTIONS: EmployeeShareVisibleSections = {
  license: true,
  experience: true,
  skills: true,
  uniform: true,
  trainingCerts: true,
  documents: true,
};

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
  // Per-link section visibility map. Null on legacy rows minted before
  // this column existed; treat null as "every section enabled" so
  // historical links keep their old behaviour.
  visibleSections: jsonb("visible_sections").$type<EmployeeShareVisibleSections>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  employeeIdx: index("employee_share_links_employee_idx").on(t.employeeUserId),
  expiresIdx: index("employee_share_links_expires_idx").on(t.expiresAt),
}));

export type EmployeeShareLink = typeof employeeShareLinksTable.$inferSelect;
