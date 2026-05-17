import { pgTable, text, uuid, timestamp, numeric, integer, jsonb } from "drizzle-orm/pg-core";
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
  // Snapshot of the `address` value at the moment we last wrote
  // locationLat/Lng. Lets the bulk backfill detect sites whose address
  // has drifted since geocoding (so coords are likely stale) and lets the
  // per-site update path invalidate coords automatically when the admin
  // edits the address without also supplying new lat/lng.
  lastGeocodedAddress: text("last_geocoded_address"),
  notes: text("notes"),
  defaultPayRate: numeric("default_pay_rate", { precision: 10, scale: 2 }),
  defaultBillRate: numeric("default_bill_rate", { precision: 10, scale: 2 }),
  // If set, on-duty officers are expected to scan at least one patrol
  // checkpoint at this site every N minutes. The missed-checkpoint
  // scheduled job pages admins when an officer goes silent past this window.
  patrolIntervalMinutes: integer("patrol_interval_minutes"),
  // Slugs of training_certifications.type that any officer working a
  // shift at this site must hold (unexpired). Empty/null = no extra
  // training requirements beyond the shift's `requiredLicenseLevel`.
  requiredTrainings: jsonb("required_trainings").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSiteSchema = createInsertSchema(sitesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sitesTable.$inferSelect;
