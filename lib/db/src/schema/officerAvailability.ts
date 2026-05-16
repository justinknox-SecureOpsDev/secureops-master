import { pgTable, uuid, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Officer-declared weekly availability windows. Each row is one
 * contiguous time-of-day window on one day of the week:
 *   dayOfWeek: 0 = Sunday … 6 = Saturday (matches JS Date#getUTCDay).
 *   startTime / endTime: "HH:MM" in UTC (24-hour).
 *
 * Multiple rows per (userId, dayOfWeek) are allowed so officers can
 * declare split availability (e.g. 06:00–12:00 AND 18:00–23:00).
 * Overnight windows (end <= start) are NOT modelled — UI splits them
 * into two rows on adjacent days.
 */
export const officerAvailabilityWindowsTable = pgTable("officer_availability_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("officer_avail_user_idx").on(t.userId),
}));

export type OfficerAvailabilityWindow = typeof officerAvailabilityWindowsTable.$inferSelect;
