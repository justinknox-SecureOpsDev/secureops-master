import { pgTable, uuid, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { timeEntriesTable } from "./timeEntries";

/**
 * Per-ping breadcrumb of where an officer has been. Written once per
 * POST /me/location call (typically ~1/min while clocked in). Keeps
 * `timeEntryId` when the officer was on an open time entry at write time
 * so the trail can be reconstructed per-shift later; `null` when the
 * ping came in off-shift.
 *
 * Pruned to 30 days by `scheduledJobs.cleanupOldLocationPings`.
 */
export const locationPingsTable = pgTable("location_pings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  timeEntryId: uuid("time_entry_id").references(() => timeEntriesTable.id, { onDelete: "set null" }),
  lat: numeric("lat", { precision: 10, scale: 6 }).notNull(),
  lng: numeric("lng", { precision: 10, scale: 6 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userCapturedIdx: index("location_pings_user_captured_idx").on(t.userId, t.capturedAt),
  capturedIdx: index("location_pings_captured_idx").on(t.capturedAt),
}));

export type LocationPing = typeof locationPingsTable.$inferSelect;
