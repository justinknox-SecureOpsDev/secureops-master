import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftAssignmentsTable } from "./shiftAssignments";
import { usersTable } from "./users";

/**
 * Officer-initiated swap of a confirmed shift assignment to another
 * qualifying officer. Lifecycle:
 *
 *   pending  → target accepts        → accepted
 *            → target declines       → declined        (terminal)
 *            → requester cancels     → cancelled       (terminal)
 *   accepted → admin approves swap   → approved        (terminal — assignment swapped)
 *            → admin rejects swap    → rejected        (terminal)
 *
 * `assignmentId` references the requester's existing accepted
 * shift_assignments row. On admin approval we delete it and create a
 * new assignments row for the target user inside one transaction.
 */
export const shiftSwapRequestsTable = pgTable("shift_swap_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentId: uuid("assignment_id").notNull().references(() => shiftAssignmentsTable.id, { onDelete: "cascade" }),
  requestingUserId: uuid("requesting_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  reason: text("reason"),
  adminApproverId: uuid("admin_approver_id").references(() => usersTable.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  targetStatusIdx: index("shift_swap_target_status_idx").on(t.targetUserId, t.status),
  requesterStatusIdx: index("shift_swap_requester_status_idx").on(t.requestingUserId, t.status),
  assignmentIdx: index("shift_swap_assignment_idx").on(t.assignmentId),
  statusIdx: index("shift_swap_status_idx").on(t.status),
}));

export const insertShiftSwapRequestSchema = createInsertSchema(shiftSwapRequestsTable).omit({
  id: true, createdAt: true, updatedAt: true, decidedAt: true, adminApproverId: true, status: true,
});
export type InsertShiftSwapRequest = z.infer<typeof insertShiftSwapRequestSchema>;
export type ShiftSwapRequest = typeof shiftSwapRequestsTable.$inferSelect;
