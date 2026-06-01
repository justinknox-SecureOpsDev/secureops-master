import { pgTable, text, uuid, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Subcontractor (vendor) master record. Standalone vendors — NOT linked to
// sites/shifts. Bank columns use US labels and mirror the employees bank
// fields so the same ACH-CSV pay-run shape works for vendor payments.
export const subcontractorsTable = pgTable("subcontractors", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  taxId: text("tax_id"), // EIN / W-9 tax ID
  address: text("address"),
  status: text("status").notNull().default("active"), // active | inactive
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  // Bank info for ACH payment execution.
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankRoutingNumber: text("bank_routing_number"),
  directDepositConsent: boolean("direct_deposit_consent").notNull().default(false),
  // Stripe Connect (scaffolded — only used when STRIPE_CONNECT_ENABLED=true).
  stripeAccountId: text("stripe_account_id"),
  w9DocKey: text("w9_doc_key"), // object-storage key for the W-9 document
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the admin grid's default sort (companyName) + id tiebreaker.
  companyIdx: index("subcontractors_company_idx").on(t.companyName, t.id),
}));

export const insertSubcontractorSchema = createInsertSchema(subcontractorsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubcontractor = z.infer<typeof insertSubcontractorSchema>;
export type Subcontractor = typeof subcontractorsTable.$inferSelect;
