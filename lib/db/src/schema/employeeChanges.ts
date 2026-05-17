import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Per-field change log of employee profile edits.
 *
 * Written by PUT /employees/:id whenever the resulting field value
 * differs from the prior value. Used to surface a "Recent Changes" panel
 * to admins (full list) and a "Recent updates" section to the officer
 * themselves on the mobile profile screen so they can spot mistakes
 * (e.g. a wrong banking number or uniform size) immediately.
 *
 * Schema choices:
 *  - `employeeUserId` is the user id of the employee whose row changed
 *    (same id used by GET /employees/:id). Cascade delete with the user.
 *  - `actorUserId` is a soft FK (`set null`) so deleting an actor user
 *    does not drop history. `actorEmail` / `actorName` preserve a
 *    human-readable label after the user is gone.
 *  - Values stored as text after JSON.stringify for objects/arrays so
 *    the table stays cheap and the UI can render them directly.
 *  - Sensitive fields (bank account #, SSN, signature, password) are
 *    redacted at write time — we record that a change happened without
 *    persisting the secret in a second place.
 */
export const employeeChangesTable = pgTable("employee_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeUserId: uuid("employee_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  actorEmail: text("actor_email"),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  source: text("source").notNull(), // "admin" | "self"
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  employeeIdx: index("employee_changes_employee_idx").on(t.employeeUserId, t.changedAt),
}));

export const insertEmployeeChangeSchema = createInsertSchema(employeeChangesTable).omit({ id: true, changedAt: true });
export type InsertEmployeeChange = z.infer<typeof insertEmployeeChangeSchema>;
export type EmployeeChange = typeof employeeChangesTable.$inferSelect;
