import { pgTable, text, uuid, timestamp, numeric, date, integer, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { applicationsTable } from "./applications";
import { onboardingSubmissionsTable } from "./onboardingSubmissions";

export const employeesTable = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  phone: text("phone"),
  address: text("address"),
  dateOfBirth: date("date_of_birth"),
  cityOfBirth: text("city_of_birth"),
  stateOfBirth: text("state_of_birth"),
  niNumber: text("ni_number"),
  rightToWorkStatus: text("right_to_work_status"),
  rightToWorkDocKey: text("right_to_work_doc_key"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactRelationship: text("emergency_contact_relationship"),
  emergencyContactPhone: text("emergency_contact_phone"),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankBsb: text("bank_bsb"),
  taxCode: text("tax_code"),
  payStubDocKey: text("pay_stub_doc_key"),
  uniformShirt: text("uniform_shirt"),
  uniformTrousers: text("uniform_trousers"),
  uniformJacket: text("uniform_jacket"),
  uniformBoots: text("uniform_boots"),
  photoKey: text("photo_key"),
  cvKey: text("cv_key"),
  licenseDocKey: text("license_doc_key"),
  passportDocKey: text("passport_doc_key"),
  siaLicenseNumber: text("sia_license_number"),
  siaLicenseLevel: integer("sia_license_level"),
  siaLicenseExpiry: date("sia_license_expiry"),
  previousExperience: text("previous_experience"),
  yearsExperience: integer("years_experience"),
  // Officer-declared cap on hours they want to be scheduled per ISO week.
  // null = no cap. Used by /me/suggested-shifts to filter out shifts that
  // would push the officer over their preferred maximum.
  maxWeeklyHours: integer("max_weekly_hours"),
  references: jsonb("references"),
  trainingCertificateKeys: jsonb("training_certificate_keys"),
  availability: jsonb("availability"),
  directDepositConsent: boolean("direct_deposit_consent"),
  directDepositSignature: text("direct_deposit_signature"),
  acknowledgements: jsonb("acknowledgements"),
  applicationId: uuid("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  onboardingSubmissionId: uuid("onboarding_submission_id").references(() => onboardingSubmissionsTable.id, { onDelete: "set null" }),
  skills: text("skills").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
