import { pgTable, text, uuid, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Audit log of all sensitive admin / payroll write operations.
 *
 * Written by `auditLogMiddleware` after each handled write. Used by ops
 * and HR to answer "who did what and when" questions — especially
 * around payroll execution, employee record changes, and admin
 * approvals.
 *
 * Schema choices:
 *  - `actorUserId` is a soft FK (`set null`) so deleting a user does
 *    not cascade-delete history; we keep the historical email so the
 *    record stays meaningful.
 *  - `before` / `after` capture row state for table-level changes
 *    (admin grid CRUD); they are nullable for non-table actions like
 *    "approve application" or "export payroll CSV".
 *  - `metadata` is a free-form sidecar (request body shape varies
 *    too much across routes to model strictly).
 */
export const auditLogsTable = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  actorEmail: text("actor_email"),
  actorRole: text("actor_role"),
  action: text("action").notNull(), // e.g. "table.update", "payroll.export-csv", "application.approve"
  targetTable: text("target_table"),
  targetId: text("target_id"),
  method: text("method").notNull(),
  path: text("path").notNull(),
  statusCode: integer("status_code"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  before: jsonb("before"),
  after: jsonb("after"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx: index("audit_logs_created_at_idx").on(t.createdAt),
  actorIdx: index("audit_logs_actor_idx").on(t.actorUserId),
  targetIdx: index("audit_logs_target_idx").on(t.targetTable, t.targetId),
}));

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
