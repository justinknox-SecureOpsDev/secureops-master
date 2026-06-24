import { pgTable, text, uuid, timestamp, numeric, date, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const paymentDiscrepanciesTable = pgTable("payment_discrepancies", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The officer/site-manager/employee who reported the discrepancy.
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  // missed_payment | underpaid | missing_hours | incorrect_rate | other
  discrepancyType: text("discrepancy_type").notNull().default("other"),
  payPeriodStart: date("pay_period_start"),
  payPeriodEnd: date("pay_period_end"),
  shiftDate: date("shift_date"),
  expectedAmount: numeric("expected_amount", { precision: 10, scale: 2 }),
  receivedAmount: numeric("received_amount", { precision: 10, scale: 2 }),
  description: text("description").notNull(),
  // open | under_review | resolved
  status: text("status").notNull().default("open"),
  adminNotes: text("admin_notes"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  employeeCreatedIdx: index("payment_discrepancies_employee_created_idx").on(t.employeeId, t.createdAt),
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("payment_discrepancies_created_idx").on(t.createdAt, t.id),
  statusIdx: index("payment_discrepancies_status_idx").on(t.status),
}));

export const insertPaymentDiscrepancySchema = createInsertSchema(paymentDiscrepanciesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPaymentDiscrepancy = z.infer<typeof insertPaymentDiscrepancySchema>;
export type PaymentDiscrepancy = typeof paymentDiscrepanciesTable.$inferSelect;
