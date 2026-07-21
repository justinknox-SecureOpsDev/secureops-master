import { pgTable, text, uuid, timestamp, integer, index } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("clients_created_idx").on(t.createdAt, t.id),
}));

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
