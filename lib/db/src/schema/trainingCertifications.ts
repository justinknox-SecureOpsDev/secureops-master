import { pgTable, text, uuid, timestamp, date, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Training certifications — structured records for non-license credentials
 * (CPR, First Aid, Fire Safety, Site Induction, PPCT, etc). The licenses
 * table covers state/regulatory licenses; this one covers everything else
 * the company tracks for compliance and shift eligibility.
 *
 * Reminder bookkeeping mirrors `licenses` exactly: a 30/14/7-day tier with
 * a `lastReminderForExpiry` that gets reset whenever expiryDate changes,
 * so renewals automatically re-arm the cycle.
 *
 * `type` is a free-form lowercase slug (e.g. "cpr", "first_aid",
 * "site_induction:plant42"). Sites reference these slugs in their
 * `requiredTrainings` array to drive compliance.
 */
export const trainingCertificationsTable = pgTable("training_certifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  issuingAuthority: text("issuing_authority"),
  certificateNumber: text("certificate_number"),
  issueDate: date("issue_date"),
  // Null = never expires (e.g. site induction with no formal expiry).
  expiryDate: date("expiry_date"),
  docKey: text("doc_key"),
  notes: text("notes"),
  lastReminderTier: integer("last_reminder_tier"),
  lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),
  lastReminderForExpiry: date("last_reminder_for_expiry"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  empTypeIdx: index("training_employee_type_idx").on(t.employeeId, t.type),
  // Includes id for the admin grid's default sort (expiryDate + id tiebreaker).
  expiryIdx: index("training_expiry_idx").on(t.expiryDate, t.id),
}));

export type TrainingCertification = typeof trainingCertificationsTable.$inferSelect;
export type InsertTrainingCertification = typeof trainingCertificationsTable.$inferInsert;
