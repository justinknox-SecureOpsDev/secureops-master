import { pgTable, text, uuid, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { incidentsTable } from "./incidents";

/**
 * Admin-minted, no-login share link for a single incident report. The
 * intended recipient is typically a client contact who needs to see the
 * report (and download the PDF / attachments) but does not have a portal
 * account. Each link is high-entropy, revocable, and expires by default
 * in 30 days.
 */
export const incidentShareLinksTable = pgTable("incident_share_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id").notNull().references(() => incidentsTable.id, { onDelete: "cascade" }),
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
  incidentIdx: index("incident_share_links_incident_idx").on(t.incidentId),
  expiresIdx: index("incident_share_links_expires_idx").on(t.expiresAt),
}));

export type IncidentShareLink = typeof incidentShareLinksTable.$inferSelect;
