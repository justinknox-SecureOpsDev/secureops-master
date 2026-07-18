import { pgTable, text, uuid, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";

/**
 * Inbound sales / sign-up leads captured from the public marketing site
 * (`artifacts/home`). The pricing + hero CTAs route prospects into a real
 * intake form that POSTs to the public `/api/leads` endpoint; each submission
 * is persisted here AND fires an admin notification email so a lead is never
 * lost even if mail delivery is misconfigured.
 *
 * This is a B2B funnel (a security company evaluating the white-label
 * platform) — distinct from `applications` (an officer applying for a job).
 */
export const salesLeadsTable = pgTable("sales_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  // The pricing tier the prospect selected on the marketing site
  // (starter | professional | enterprise | unsure). Free text so the
  // marketing copy can evolve without a schema migration.
  tier: text("tier"),
  // Rough officer headcount the prospect operates (drives the quote).
  officerCount: integer("officer_count"),
  message: text("message"),
  // Where the lead originated, e.g. pricing_starter | pricing_professional |
  // pricing_enterprise | hero | pricing_footer.
  source: text("source").notNull().default("marketing_site"),
  // new | contacted | qualified | won | lost | converted
  status: text("status").notNull().default("new"),
  adminNotes: text("admin_notes"),
  // Set when an admin uses "Convert to client": links this won lead to the
  // clients row that was created from it, and stamps when the conversion ran.
  // Together they make the conversion idempotent (a lead can be converted once)
  // and let the grid show which leads have already become customers.
  convertedClientId: uuid("converted_client_id").references(() => clientsTable.id, { onDelete: "set null" }),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("sales_leads_created_idx").on(t.createdAt, t.id),
  statusIdx: index("sales_leads_status_idx").on(t.status),
}));

export const insertSalesLeadSchema = createInsertSchema(salesLeadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Conversion bookkeeping is set only by the "Convert to client" action,
  // never via the public intake form or the generic admin create/edit.
  convertedClientId: true,
  convertedAt: true,
});
export type InsertSalesLead = z.infer<typeof insertSalesLeadSchema>;
export type SalesLead = typeof salesLeadsTable.$inferSelect;
