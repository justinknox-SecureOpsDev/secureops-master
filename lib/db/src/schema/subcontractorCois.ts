import { pgTable, text, uuid, timestamp, date, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { subcontractorsTable } from "./subcontractors";

// Certificate of Insurance (COI) for a subcontractor. Expiry-reminder
// bookkeeping mirrors licenses/training-certifications: tiered reminders at
// 60/30/14/7 days, idempotent via lastReminderTier + lastReminderForExpiry.
export const subcontractorCoisTable = pgTable("subcontractor_cois", {
  id: uuid("id").primaryKey().defaultRandom(),
  subcontractorId: uuid("subcontractor_id").notNull().references(() => subcontractorsTable.id, { onDelete: "cascade" }),
  // general_liability | workers_comp | auto | umbrella | professional | other
  coverageType: text("coverage_type").notNull().default("general_liability"),
  insurer: text("insurer"),
  policyNumber: text("policy_number"),
  coverageAmount: numeric("coverage_amount", { precision: 12, scale: 2 }),
  effectiveDate: date("effective_date"),
  expiryDate: date("expiry_date").notNull(),
  documentKey: text("document_key"), // object-storage key for the COI PDF
  notes: text("notes"),
  // Reminder bookkeeping (see scheduledJobs.sendCoiExpiryReminders).
  lastReminderTier: integer("last_reminder_tier"),
  lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),
  lastReminderForExpiry: date("last_reminder_for_expiry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSubcontractorCoiSchema = createInsertSchema(subcontractorCoisTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubcontractorCoi = z.infer<typeof insertSubcontractorCoiSchema>;
export type SubcontractorCoi = typeof subcontractorCoisTable.$inferSelect;
