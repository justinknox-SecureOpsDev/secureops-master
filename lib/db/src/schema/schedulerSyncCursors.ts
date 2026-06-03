import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tracks the reconciliation cursor for the Event Staff Scheduler integration.
 * One row per `cursorKey` (e.g. "shifts" or "clock_events"). The stored
 * `cursorValue` is an opaque ISO-8601 timestamp that the scheduler's delta
 * endpoint accepts as `since=` — SecureOps advances it after every successful
 * reconciliation pull.
 */
export const schedulerSyncCursorsTable = pgTable("scheduler_sync_cursors", {
  cursorKey: text("cursor_key").primaryKey(),
  cursorValue: text("cursor_value").notNull().default("1970-01-01T00:00:00.000Z"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
  lastSyncShiftsProcessed: text("last_sync_shifts_processed").default("0"),
  lastSyncEventsProcessed: text("last_sync_events_processed").default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SchedulerSyncCursor = typeof schedulerSyncCursorsTable.$inferSelect;
