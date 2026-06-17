import { pgTable, text, uuid, timestamp, integer, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";

/**
 * An ordered stop on a protection detail's itinerary (hotel, venue, airport,
 * safe house, …). Geocoded best-effort from `address` so the mobile app can
 * render a map / open-in-maps link. All fields optional; `seq` orders the
 * itinerary. lat/lng use the same numeric(10,6) precision as sites/shifts.
 */
export const protectionDestinationsTable = pgTable("protection_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => shiftsTable.id, { onDelete: "cascade" }),
  // Itinerary ordering.
  seq: integer("seq").notNull().default(0),
  label: text("label"),
  address: text("address"),
  lat: numeric("lat", { precision: 10, scale: 6 }),
  lng: numeric("lng", { precision: 10, scale: 6 }),
  arrivalTime: timestamp("arrival_time", { withTimezone: true }),
  departureTime: timestamp("departure_time", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  shiftIdx: index("protection_destinations_shift_idx").on(t.shiftId),
}));

export const insertProtectionDestinationSchema = createInsertSchema(protectionDestinationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProtectionDestination = z.infer<typeof insertProtectionDestinationSchema>;
export type ProtectionDestination = typeof protectionDestinationsTable.$inferSelect;
