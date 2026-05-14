import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";
import { usersTable } from "./users";

export const shiftAssignmentsTable = pgTable("shift_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => shiftsTable.id, { onDelete: "cascade" }),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  shiftEmployeeUnique: uniqueIndex("shift_assignments_shift_employee_unique").on(t.shiftId, t.employeeId),
}));

export const insertShiftAssignmentSchema = createInsertSchema(shiftAssignmentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertShiftAssignment = z.infer<typeof insertShiftAssignmentSchema>;
export type ShiftAssignment = typeof shiftAssignmentsTable.$inferSelect;
