import { pgTable, text, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";
import { usersTable } from "./users";

export const shiftAssignmentsTable = pgTable("shift_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => shiftsTable.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  // Pre-shift reminder bookkeeping. The scheduled reminder job sets these
  // when it sends "starts in 2 hours" / "starts in 30 minutes" pushes so
  // the same officer is never reminded twice for the same shift.
  reminder2hSentAt: timestamp("reminder_2h_sent_at", { withTimezone: true }),
  reminder30mSentAt: timestamp("reminder_30m_sent_at", { withTimezone: true }),
  // Idempotency flag for the pending-claim approval reminder. The scheduled
  // job stamps this when it notifies site managers that a claim has been
  // sitting in `pending_approval` for more than 2 hours without action.
  // NULL = not yet reminded; once set, the job never re-sends for this claim.
  claimReminderSentAt: timestamp("claim_reminder_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  shiftEmployeeUnique: uniqueIndex("shift_assignments_shift_employee_unique").on(t.shiftId, t.employeeId),
  shiftStatusIdx: index("shift_assignments_shift_status_idx").on(t.shiftId, t.status),
  employeeIdx: index("shift_assignments_employee_idx").on(t.employeeId),
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("shift_assignments_created_idx").on(t.createdAt, t.id),
}));

export const insertShiftAssignmentSchema = createInsertSchema(shiftAssignmentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShiftAssignment = z.infer<typeof insertShiftAssignmentSchema>;
export type ShiftAssignment = typeof shiftAssignmentsTable.$inferSelect;
