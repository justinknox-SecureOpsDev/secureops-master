import { pgTable, text, uuid, timestamp, boolean, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
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
  // Admin-set pay-rate override for this single entry. Takes precedence
  // over shifts.pay_rate and employees.hourly_rate when present, and is
  // the mechanism the Payroll Board "Apply pay rate" action writes to so
  // admins can backfill historical clock-ins (and ad-hoc geo clock-ins
  // with no shift) that would otherwise be invoiced at $0/hr. NULL means
  // "use the inherited rate" (existing shift -> employee fallback).
  payRateOverride: numeric("pay_rate_override", { precision: 8, scale: 2 }),
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
  // Debounce timestamp for missed-checkpoint pages — we only notify admins
  // once per `sites.patrolIntervalMinutes` window per active shift.
  patrolLastNotifiedAt: timestamp("patrol_last_notified_at", { withTimezone: true }),
  // Forgot-to-clock-out reminders sent to the officer when they're still
  // clocked in past their assigned shift's scheduled end. Two tiers (~20m
  // and ~60m after end). Stamped per-tier so we never re-send for the
  // same active shift. NOT cleared on clock-out — the reminder job
  // filters by `clock_out_time IS NULL` so stale stamps never re-fire,
  // and keeping them around preserves the audit trail.
  clockOutReminder1SentAt: timestamp("clock_out_reminder1_sent_at", { withTimezone: true }),
  clockOutReminder2SentAt: timestamp("clock_out_reminder2_sent_at", { withTimezone: true }),
  // External-sync fields for Event Staff Scheduler integration.
  // externalId = the scheduler's clock-event ID; used for idempotent upsert.
  // externalSource = 'scheduler' (only known external source).
  // externalUpdatedAt = scheduler's updatedAt for last-write-wins conflict resolution.
  // syncSource = 'local' | 'scheduler'; 'scheduler' suppresses outbound echo (loop prevention).
  externalId: text("external_id"),
  externalSource: text("external_source"),
  externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
  syncSource: text("sync_source").notNull().default("local"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  employeeClockInIdx: index("time_entries_employee_clockin_idx").on(t.employeeId, t.clockInTime),
  approvalIdx: index("time_entries_approval_idx").on(t.approvalStatus),
  siteIdx: index("time_entries_site_idx").on(t.siteId),
  // Backs the admin grid's default sort (clockInTime desc) + id tiebreaker.
  // Leading clockInTime, distinct from the employee-scoped index above.
  clockInIdx: index("time_entries_clockin_idx").on(t.clockInTime, t.id),
  // Unique constraint on (externalSource, externalId) for atomic concurrent upserts.
  // NULL values do not violate uniqueness in Postgres, so local-only rows are safe.
  externalIdx: uniqueIndex("time_entries_external_uniq").on(t.externalSource, t.externalId),
}));

export const insertTimeEntrySchema = createInsertSchema(timeEntriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type TimeEntry = typeof timeEntriesTable.$inferSelect;
