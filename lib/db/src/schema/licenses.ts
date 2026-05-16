import { pgTable, text, uuid, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const licensesTable = pgTable("licenses", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  level: integer("level"),
  licenseNumber: text("license_number").notNull(),
  issuingAuthority: text("issuing_authority"),
  issueDate: date("issue_date"),
  expiryDate: date("expiry_date").notNull(),
  notes: text("notes"),
  // Expiry-reminder bookkeeping. We send tiered reminders at 30 / 14 / 7
  // days before expiry. `lastReminderTier` is the smallest threshold we
  // have already sent for the current expiryDate, so we never re-send
  // the same tier and never skip a tier when expiry is updated.
  lastReminderTier: integer("last_reminder_tier"),
  lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),
  // The expiry date the most-recent reminder was sent FOR. When the
  // license is renewed (expiryDate changes), the cron sees this no
  // longer matches and treats the bookkeeping as cleared, so the new
  // expiry gets a full 30/14/7 reminder cycle.
  lastReminderForExpiry: date("last_reminder_for_expiry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLicenseSchema = createInsertSchema(licensesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type License = typeof licensesTable.$inferSelect;
