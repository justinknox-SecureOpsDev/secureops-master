import { pgTable, text, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/**
 * Persistent subcontractor QR clock-in token, scoped to a SITE (not a shift).
 *
 * One active token per site. Subcontractors scan the printed QR on arrival,
 * enter their name + company, and the same QR toggles them clocked in / out.
 * The token is long-lived (no expiry) so a single printed QR keeps working;
 * admins can rotate it (which replaces the token in place) if a code leaks.
 */
export const subcontractorQrTokensTable = pgTable("subcontractor_qr_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdByAdminId: uuid("created_by_admin_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  siteUniq: uniqueIndex("subcontractor_qr_tokens_site_uniq").on(t.siteId),
  tokenIdx: index("subcontractor_qr_tokens_token_idx").on(t.token),
}));

export const insertSubcontractorQrTokenSchema = createInsertSchema(subcontractorQrTokensTable).omit({ id: true, createdAt: true });
export type InsertSubcontractorQrToken = z.infer<typeof insertSubcontractorQrTokenSchema>;
export type SubcontractorQrToken = typeof subcontractorQrTokensTable.$inferSelect;
