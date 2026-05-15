import { pgTable, text, uuid, timestamp, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";

/**
 * site_roles is a per-site rate card. Each site can have several roles
 * (e.g. "Kanvas Level 2", "Vivo Floor Lead") with their own pay/bill rates
 * and required licence level. Posting a shift can pick a role to auto-fill
 * those fields instead of typing rates every time.
 */
export const siteRolesTable = pgTable("site_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  requiredLicenseLevel: integer("required_license_level").notNull().default(2),
  payRate: numeric("pay_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  billRate: numeric("bill_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSiteRoleSchema = createInsertSchema(siteRolesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSiteRole = z.infer<typeof insertSiteRoleSchema>;
export type SiteRole = typeof siteRolesTable.$inferSelect;
