import { pgTable, text, uuid, timestamp, boolean, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const shiftsTable = pgTable("shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  clientName: text("client_name").notNull(),
  location: text("location").notNull(),
  locationLat: numeric("location_lat", { precision: 10, scale: 6 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 6 }),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull(),
  billableRate: numeric("billable_rate", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("upcoming"),
  requiredLicenseLevel: integer("required_license_level").notNull().default(2),
  headcount: integer("headcount").notNull().default(1),
  isRepeat: boolean("is_repeat").notNull().default(false),
  repeatPattern: text("repeat_pattern"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertShiftSchema = createInsertSchema(shiftsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShift = z.infer<typeof insertShiftSchema>;
export type Shift = typeof shiftsTable.$inferSelect;
