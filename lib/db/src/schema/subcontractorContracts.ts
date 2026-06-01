import { pgTable, text, uuid, timestamp, date, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subcontractorsTable } from "./subcontractors";

// Contract / agreement with a subcontractor.
export const subcontractorContractsTable = pgTable("subcontractor_contracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  subcontractorId: uuid("subcontractor_id").notNull().references(() => subcontractorsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  contractType: text("contract_type"),
  status: text("status").notNull().default("active"), // draft | active | expired | terminated
  startDate: date("start_date"),
  endDate: date("end_date"),
  value: numeric("value", { precision: 12, scale: 2 }),
  documentKey: text("document_key"), // object-storage key for the signed contract
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("subcontractor_contracts_created_idx").on(t.createdAt, t.id),
}));

export const insertSubcontractorContractSchema = createInsertSchema(subcontractorContractsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubcontractorContract = z.infer<typeof insertSubcontractorContractSchema>;
export type SubcontractorContract = typeof subcontractorContractsTable.$inferSelect;
