import { pgTable, text, uuid, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const onboardingSubmissionsTable = pgTable("onboarding_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }).unique(),
  bankSortCode: text("bank_sort_code"),
  bankAccountNumber: text("bank_account_number"),
  bankAccountName: text("bank_account_name"),
  niNumberConfirmed: text("ni_number_confirmed"),
  taxCode: text("tax_code"),
  p45DocKey: text("p45_doc_key"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactRelationship: text("emergency_contact_relationship"),
  emergencyContactPhone: text("emergency_contact_phone"),
  uniformShirt: text("uniform_shirt"),
  uniformTrousers: text("uniform_trousers"),
  uniformJacket: text("uniform_jacket"),
  uniformBoots: text("uniform_boots"),
  siaLicenseDocKey: text("sia_license_doc_key"),
  passportDocKey: text("passport_doc_key"),
  directDepositConsent: boolean("direct_deposit_consent").notNull().default(false),
  directDepositSignature: text("direct_deposit_signature"),
  // acknowledgements: array of { type, accepted, signature, timestamp }
  acknowledgements: jsonb("acknowledgements"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertOnboardingSubmissionSchema = createInsertSchema(onboardingSubmissionsTable).omit({
  id: true, submittedAt: true, createdAt: true, updatedAt: true,
});
export type InsertOnboardingSubmission = z.infer<typeof insertOnboardingSubmissionSchema>;
export type OnboardingSubmission = typeof onboardingSubmissionsTable.$inferSelect;
