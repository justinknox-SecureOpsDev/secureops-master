import { pgTable, text, uuid, timestamp, integer, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";

export const shiftRequestsTable = pgTable("shift_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  // Single-date requests: startDate == endDate; multi-day requests span the range
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  // Wall-clock times (HH:MM) — stored as text to avoid timezone confusion
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  // Per-license-level headcount breakdown (0 = none needed)
  l2Count: integer("l2_count").notNull().default(0),
  l3Count: integer("l3_count").notNull().default(0),
  l4Count: integer("l4_count").notNull().default(0),
  // Additional notes from the client
  notes: text("notes"),
  // Status lifecycle: pending → approved | declined
  status: text("status").notNull().default("pending"),
  // Admin note set on approval or decline
  adminNote: text("admin_note"),
  // UUIDs of real shifts created when approved (jsonb array of strings)
  createdShiftIds: jsonb("created_shift_ids").$type<string[]>(),
  // Who submitted and who reviewed
  submittedByUserId: uuid("submitted_by_user_id"),
  reviewedByUserId: uuid("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertShiftRequestSchema = createInsertSchema(shiftRequestsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertShiftRequest = z.infer<typeof insertShiftRequestSchema>;
export type ShiftRequest = typeof shiftRequestsTable.$inferSelect;
