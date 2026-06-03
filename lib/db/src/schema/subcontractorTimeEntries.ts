import { pgTable, text, uuid, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";
import { subcontractorQrTokensTable } from "./subcontractorQrTokens";

/**
 * A subcontractor clock-in/out record, anchored to a SITE.
 *
 * Created when an unknown subcontractor (no system account) scans the site QR
 * and enters their name + company. The same QR toggles: an open entry
 * (clockOutAt IS NULL) matching (siteId, name, company) is clocked out on the
 * next scan; otherwise a fresh entry is opened.
 */
export const subcontractorTimeEntriesTable = pgTable("subcontractor_time_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  qrTokenId: uuid("qr_token_id").references(() => subcontractorQrTokensTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  company: text("company").notNull(),
  badgeId: text("badge_id"),
  clockInAt: timestamp("clock_in_at", { withTimezone: true }).notNull(),
  clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
  hoursWorked: numeric("hours_worked", { precision: 6, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  siteIdx: index("sub_time_entries_site_idx").on(t.siteId),
  clockInIdx: index("sub_time_entries_clock_in_idx").on(t.clockInAt, t.id),
  openLookupIdx: index("sub_time_entries_open_lookup_idx").on(t.siteId, t.clockOutAt),
}));

export const insertSubcontractorTimeEntrySchema = createInsertSchema(subcontractorTimeEntriesTable).omit({ id: true, createdAt: true });
export type InsertSubcontractorTimeEntry = z.infer<typeof insertSubcontractorTimeEntrySchema>;
export type SubcontractorTimeEntry = typeof subcontractorTimeEntriesTable.$inferSelect;
