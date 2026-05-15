import { pgTable, text, uuid, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Policy documents for onboarding acknowledgements.
 *
 * One row per (slug, version). Multiple rows per slug — old versions are
 * retained as immutable history. The currently-published version of a slug
 * is the row with isActive=true (at most one per slug at any time, enforced
 * in application code, not by a unique constraint).
 *
 * A slug is "deactivated" when no row of that slug has isActive=true.
 * A slug is "live on the onboarding form" when its active row also has a
 * non-null fileKey.
 */
export const policiesTable = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  label: text("label").notNull(),
  version: integer("version").notNull().default(1),
  fileKey: text("file_key"),
  fileName: text("file_name"),
  isActive: boolean("is_active").notNull().default(true),
  uploadedBy: uuid("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  slugIdx: index("policies_slug_idx").on(t.slug),
}));

export const insertPolicySchema = createInsertSchema(policiesTable).omit({
  id: true, version: true, fileKey: true, fileName: true,
  uploadedBy: true, uploadedAt: true, createdAt: true, updatedAt: true,
});
export type InsertPolicy = z.infer<typeof insertPolicySchema>;
export type Policy = typeof policiesTable.$inferSelect;
