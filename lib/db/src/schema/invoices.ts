import { pgTable, text, uuid, timestamp, date, numeric, jsonb, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";

export const invoicesTable = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  // New canonical links to client + site; client_name/email/address kept for snapshot/back-compat.
  clientId: uuid("client_id").references(() => clientsTable.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  clientAddress: text("client_address"),
  lineItems: jsonb("line_items").notNull().default([]),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  status: text("status").notNull().default("draft"), // draft | sent | paid | overdue
  dueDate: date("due_date").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  notes: text("notes"),
  // Stripe invoice payment (client portal). Both columns are nullable —
  // they are only populated when a client pays online via Stripe Checkout.
  // stripeCheckoutSessionId: the Checkout session used to initiate payment.
  // stripePaymentIntentId: the confirmed PaymentIntent (authoritative source of truth).
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  // Auto-population bookkeeping (May 2026):
  //   autoSynced = true  → invoiceSync.ts is allowed to rebuild line items
  //                         from approved time entries for this site+week.
  //                         Flipped to false the first time an admin edits
  //                         lineItems / subtotal / totalAmount / tax so we
  //                         never clobber a hand-tuned invoice.
  //   lockedAt   = !null → the week has ended (or admin explicitly locked).
  //                         New approvals roll into the next week's draft
  //                         instead of touching this row.
  autoSynced: boolean("auto_synced").notNull().default(true),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  // At most ONE actively-syncing draft per (site, week). Allows a separate
  // adjustment draft once the original is locked at week-end (locked_at IS
  // NOT NULL excludes it), and allows the auto-sync upsert to coexist with
  // a hand-edited draft (auto_synced=false excludes it). Together with the
  // race-safe INSERT in invoiceSync.ts, this guarantees that two concurrent
  // approvals can never produce duplicate auto-synced drafts.
  activeAutoDraftPerSiteWeek: uniqueIndex("invoices_active_auto_draft_per_week_idx")
    .on(table.siteId, table.periodStart)
    .where(sql`status = 'draft' AND locked_at IS NULL AND auto_synced = true`),
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("invoices_created_idx").on(table.createdAt, table.id),
}));

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
