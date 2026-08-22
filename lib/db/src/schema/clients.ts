import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const BILLING_CYCLES = ["weekly", "biweekly", "semi_monthly", "monthly", "custom"] as const;
export type BillingCycle = typeof BILLING_CYCLES[number];

export const clientsTable = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  billingAddress: text("billing_address"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  billingCycle: text("billing_cycle").notNull().default("weekly"),
  notes: text("notes"),
  contractDocKey: text("contract_doc_key"),
  // External tenant/service identifier set by the Control Plane. Optional for
  // clients created directly in the tenant application.
  externalCustomerId: text("external_customer_id"),
  legalName: text("legal_name"),
  primaryContactName: text("primary_contact_name"),
  primaryContactEmail: text("primary_contact_email"),
  primaryContactPhone: text("primary_contact_phone"),
  serviceAddress: text("service_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("clients_created_idx").on(t.createdAt, t.id),
  externalCustomerIdUniq: uniqueIndex("clients_external_customer_id_uniq")
    .on(t.externalCustomerId)
    .where(sql`external_customer_id IS NOT NULL`),
}));

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
