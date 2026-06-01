import { pgTable, text, uuid, timestamp, date, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subcontractorsTable } from "./subcontractors";
import { usersTable } from "./users";

// Accounts-payable invoice received FROM a subcontractor. Processing flow:
// pending -> approved/rejected -> processed (ACH CSV exported) -> paid.
// Payment-execution columns mirror payroll_entries so the Pay Run shape is
// identical (paidBy / paidMethod / paymentReference / stripeTransferId).
export const subcontractorInvoicesTable = pgTable("subcontractor_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  subcontractorId: uuid("subcontractor_id").notNull().references(() => subcontractorsTable.id, { onDelete: "cascade" }),
  invoiceNumber: text("invoice_number").notNull(),
  description: text("description"),
  issueDate: date("issue_date"),
  dueDate: date("due_date"),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // pending | approved | rejected | processed | paid | failed
  status: text("status").notNull().default("pending"),
  documentKey: text("document_key"), // object-storage key for the invoice PDF
  approvedBy: uuid("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidBy: uuid("paid_by").references(() => usersTable.id, { onDelete: "set null" }),
  paidMethod: text("paid_method"), // manual | ach_csv | stripe
  paymentReference: text("payment_reference"),
  stripeTransferId: text("stripe_transfer_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSubcontractorInvoiceSchema = createInsertSchema(subcontractorInvoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubcontractorInvoice = z.infer<typeof insertSubcontractorInvoiceSchema>;
export type SubcontractorInvoice = typeof subcontractorInvoicesTable.$inferSelect;
