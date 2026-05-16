import { pgTable, uuid, text, integer, timestamp, date, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { sitesTable } from "./sites";
import { shiftsTable } from "./shifts";
import { timeEntriesTable } from "./timeEntries";

/**
 * Daily Officer Activity Report (DAR) — the end-of-shift narrative the
 * officer submits summarizing their tour. One row per submission; an
 * officer may file multiple DARs in a day (e.g. split shift / multiple
 * sites). Admins see a global feed; clients can be granted access in a
 * later wave.
 */
export const dailyActivityReportsTable = pgTable("daily_activity_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  shiftId: uuid("shift_id").references(() => shiftsTable.id, { onDelete: "set null" }),
  timeEntryId: uuid("time_entry_id").references(() => timeEntriesTable.id, { onDelete: "set null" }),
  // The calendar date the report covers (UTC). Distinct from submittedAt so
  // admins can group by service date.
  reportDate: date("report_date").notNull(),
  summary: text("summary").notNull(),
  observations: text("observations"),
  visitorsCount: integer("visitors_count").notNull().default(0),
  patrolsCount: integer("patrols_count").notNull().default(0),
  incidentsNoted: text("incidents_noted"),
  weather: text("weather"),
  // Officer-typed name acting as a signature.
  signature: text("signature"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  empDateIdx: index("dar_employee_date_idx").on(t.employeeId, t.reportDate),
  siteDateIdx: index("dar_site_date_idx").on(t.siteId, t.reportDate),
  submittedIdx: index("dar_submitted_idx").on(t.submittedAt),
}));

export type DailyActivityReport = typeof dailyActivityReportsTable.$inferSelect;
export type InsertDailyActivityReport = typeof dailyActivityReportsTable.$inferInsert;
