import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Per-officer queue of high-risk profile changes awaiting a digest send.
 *
 * Each row represents a single high-risk field that flipped value during a
 * self-edit. The scheduled `high-risk-digest` job coalesces all pending
 * rows for an officer into one push + one email so admins are not pinged
 * on every keystroke. A digest is released when the OLDEST pending row
 * for that officer is at least `HIGH_RISK_DIGEST_WINDOW_MS` (15 min) old.
 *
 * Rows are claimed atomically via `DELETE … RETURNING` so two app
 * instances can never double-send the same digest. If the send fails the
 * rows are re-inserted with their original detectedAt so the next tick
 * retries.
 */
export const highRiskChangeQueueTable = pgTable("high_risk_change_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeUserId: uuid("employee_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  employeeIdx: index("high_risk_change_queue_employee_idx").on(t.employeeUserId, t.detectedAt),
  detectedIdx: index("high_risk_change_queue_detected_idx").on(t.detectedAt),
}));

export type HighRiskChangeQueueRow = typeof highRiskChangeQueueTable.$inferSelect;
