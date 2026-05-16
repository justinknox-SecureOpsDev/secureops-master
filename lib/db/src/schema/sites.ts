import { pgTable, text, uuid, timestamp, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";

export const sitesTable = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  locationLat: numeric("location_lat", { precision: 10, scale: 6 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 6 }),
  notes: text("notes"),
  defaultPayRate: numeric("default_pay_rate", { precision: 10, scale: 2 }),
  defaultBillRate: numeric("default_bill_rate", { precision: 10, scale: 2 }),
  // If set, on-duty officers are expected to scan at least one patrol
  // checkpoint at this site every N minutes. The missed-checkpoint
  // scheduled job pages admins when an officer goes silent past this window.
  patrolIntervalMinutes: integer("patrol_interval_minutes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSiteSchema = createInsertSchema(sitesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sitesTable.$inferSelect;
