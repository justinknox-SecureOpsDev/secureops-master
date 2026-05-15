import { pgTable, text, uuid, timestamp, date, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { sitesTable } from "./sites";

export const payrollEntriesTable = pgTable("payroll_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  // Payroll is processed weekly per site. siteId may be null only for legacy rows.
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  totalHours: numeric("total_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  grossPay: numeric("gross_pay", { precision: 10, scale: 2 }).notNull().default("0"),
  tax: numeric("tax", { precision: 10, scale: 2 }).notNull().default("0"),
  netPay: numeric("net_pay", { precision: 10, scale: 2 }).notNull().default("0"),
  status: text("status").notNull().default("pending"), // pending | processed | paid | failed
  paidAt: timestamp("paid_at", { withTimezone: true }),
  // Audit trail for "executed" payments.
  paidBy: uuid("paid_by").references(() => usersTable.id, { onDelete: "set null" }),
  paidMethod: text("paid_method"), // manual | ach_csv | stripe
  paymentReference: text("payment_reference"), // bank confirmation # / file batch id / stripe transfer id
  stripeTransferId: text("stripe_transfer_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniquePerWeek: uniqueIndex("payroll_employee_site_week_unique").on(t.employeeId, t.siteId, t.periodStart),
}));

export const insertPayrollEntrySchema = createInsertSchema(payrollEntriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPayrollEntry = z.infer<typeof insertPayrollEntrySchema>;
export type PayrollEntry = typeof payrollEntriesTable.$inferSelect;
