import { pgTable, text, uuid, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const policiesTable = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  version: integer("version").notNull().default(0),
  fileKey: text("file_key"),
  fileName: text("file_name"),
  uploadedBy: uuid("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPolicySchema = createInsertSchema(policiesTable).omit({
  id: true, version: true, fileKey: true, fileName: true,
  uploadedBy: true, uploadedAt: true, createdAt: true, updatedAt: true,
});
export type InsertPolicy = z.infer<typeof insertPolicySchema>;
export type Policy = typeof policiesTable.$inferSelect;
