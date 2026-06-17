import { pgTable, text, uuid, timestamp, boolean, numeric, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";
import { siteRatesTable } from "./siteRates";

export const shiftsTable = pgTable("shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  // siteId is the new canonical link. clientName/location kept nullable for back-compat.
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  clientName: text("client_name"),
  location: text("location"),
  locationLat: numeric("location_lat", { precision: 10, scale: 6 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 6 }),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  // payRate = what the officer earns; billRate = what the client is billed.
  payRate: numeric("pay_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  billRate: numeric("bill_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  // Legacy aliases retained so existing data and code keep working.
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  billableRate: numeric("billable_rate", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("upcoming"),
  // 'standard' for ordinary guard shifts; 'ppo_detail' unlocks the executive /
  // close-protection package (protection_details + protection_persons +
  // protection_destinations). Default keeps every existing shift standard.
  shiftType: text("shift_type").notNull().default("standard"),
  requiredLicenseLevel: integer("required_license_level").notNull().default(2),
  // Optional FK to the site's pay/bill rate card for this license level.
  // When set on shift create/edit, the shift's payRate + billRate are
  // populated from this row; admin can still override per-shift.
  siteRateId: uuid("site_rate_id").references(() => siteRatesTable.id, { onDelete: "set null" }),
  headcount: integer("headcount").notNull().default(1),
  isRepeat: boolean("is_repeat").notNull().default(false),
  repeatPattern: text("repeat_pattern"),
  // Stable id shared by every occurrence created from a single repeat series.
  // Nullable so legacy rows and ad-hoc single shifts keep working; admin UI
  // groups by seriesId when present and falls back to site+title+pattern.
  seriesId: uuid("series_id"),
  notes: text("notes"),
  // External-sync fields for Event Staff Scheduler integration.
  // externalId = the scheduler's own ID for this shift.
  // externalSource = 'scheduler' (only known external source for now).
  // externalUpdatedAt = the scheduler's updatedAt for last-write-wins conflict resolution.
  // syncSource = 'local' | 'scheduler'; 'scheduler' means the change originated from the
  //   scheduler — the outbound sync hook skips echoing it back (loop prevention).
  externalId: text("external_id"),
  externalSource: text("external_source"),
  externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
  syncSource: text("sync_source").notNull().default("local"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  siteStartIdx: index("shifts_site_start_idx").on(t.siteId, t.startTime),
  // Includes id so the admin grid's default sort (startTime + id tiebreaker)
  // and the row-position deep-link stay fully index-ordered at scale.
  startIdx: index("shifts_start_idx").on(t.startTime, t.id),
  seriesIdx: index("shifts_series_idx").on(t.seriesId),
  // Unique constraint on (externalSource, externalId) for atomic concurrent upserts.
  // NULL values do not violate uniqueness in Postgres, so local-only rows are safe.
  externalIdx: uniqueIndex("shifts_external_uniq").on(t.externalSource, t.externalId),
}));

export const insertShiftSchema = createInsertSchema(shiftsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShift = z.infer<typeof insertShiftSchema>;
export type Shift = typeof shiftsTable.$inferSelect;
