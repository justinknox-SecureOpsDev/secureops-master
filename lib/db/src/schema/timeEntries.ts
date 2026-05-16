import { pgTable, text, uuid, timestamp, boolean, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const timeEntriesTable = pgTable("time_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  // shiftId is now optional — officers can clock in without an assigned shift if they're
  // within range of a known site (siteId is then resolved by GPS).
  shiftId: uuid("shift_id").references(() => shiftsTable.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  clockInTime: timestamp("clock_in_time", { withTimezone: true }).notNull(),
  clockInLat: numeric("clock_in_lat", { precision: 10, scale: 6 }),
  clockInLng: numeric("clock_in_lng", { precision: 10, scale: 6 }),
  clockOutTime: timestamp("clock_out_time", { withTimezone: true }),
  clockOutLat: numeric("clock_out_lat", { precision: 10, scale: 6 }),
  clockOutLng: numeric("clock_out_lng", { precision: 10, scale: 6 }),
  hoursWorked: numeric("hours_worked", { precision: 6, scale: 2 }),
  isVerified: boolean("is_verified").notNull().default(false),
  // Approval workflow: admin must approve before payroll/invoicing picks up the entry.
  approvalStatus: text("approval_status").notNull().default("pending"), // pending | approved | rejected
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  // Live geofence state for THIS active shift. `inside` while the officer's
  // last location ping is within GEOFENCE_RADIUS_MILES of the shift's site,
  // `outside` if they've drifted out (admins are pushed once on the
  // transition), `null` if we've never had a usable ping yet. Reset on
  // clock-out — geofence is only meaningful while clocked in.
  geofenceState: text("geofence_state"),
  geofenceLastBreachAt: timestamp("geofence_last_breach_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  employeeClockInIdx: index("time_entries_employee_clockin_idx").on(t.employeeId, t.clockInTime),
  approvalIdx: index("time_entries_approval_idx").on(t.approvalStatus),
  siteIdx: index("time_entries_site_idx").on(t.siteId),
}));

export const insertTimeEntrySchema = createInsertSchema(timeEntriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type TimeEntry = typeof timeEntriesTable.$inferSelect;
