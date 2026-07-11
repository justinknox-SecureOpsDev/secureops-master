import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Shared admin to-do / reminder list surfaced on the admin dashboard.
 * One team-wide list: every admin sees every task; createdBy is attribution,
 * not ownership. A task is "open" while completedAt IS NULL.
 */
export const adminTasksTable = pgTable("admin_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  notes: text("notes"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the dashboard list: open tasks first, ordered by due date.
  dueIdx: index("admin_tasks_due_idx").on(t.completedAt, t.dueAt, t.id),
}));

export const insertAdminTaskSchema = createInsertSchema(adminTasksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAdminTask = z.infer<typeof insertAdminTaskSchema>;
export type AdminTask = typeof adminTasksTable.$inferSelect;
