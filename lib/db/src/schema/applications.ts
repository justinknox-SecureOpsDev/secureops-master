import { pgTable, text, uuid, timestamp, integer, date, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const applicationsTable = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("submitted"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  address: text("address").notNull(),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  locationLat: numeric("location_lat", { precision: 10, scale: 6 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 6 }),
  dateOfBirth: date("date_of_birth"),
  cityOfBirth: text("city_of_birth"),
  stateOfBirth: text("state_of_birth"),
  niNumber: text("ni_number"),
  rightToWorkStatus: text("right_to_work_status"),
  rightToWorkDocKey: text("right_to_work_doc_key"),
  // I-9 employment eligibility (replaces the old generic right-to-work doc).
  // i9DocKey   = applicant-completed Form I-9 (PDF / scan)
  // ssnCardDocKey = photo / scan of Social Security card
  // idDocType  = "drivers_license" | "passport"
  // idDocKey   = photo / scan of the chosen ID
  i9DocKey: text("i9_doc_key"),
  // In-app fillable Form I-9 Section 1 (replaces the i9DocKey upload for new
  // applications): { otherLastNames?, citizenshipStatus, uscisANumber?,
  // i94Number?, foreignPassportNumber?, foreignPassportCountry?,
  // workAuthExpiration?, usedPreparer?, preparerName?, attestation,
  // signatureName, signedDate }. Contains work-authorization identifiers
  // (A-Number / I-94 / passport number) — sensitive PII, admin-only surfaces.
  i9Data: jsonb("i9_data"),
  ssnCardDocKey: text("ssn_card_doc_key"),
  idDocType: text("id_doc_type"),
  idDocKey: text("id_doc_key"),
  siaLicenseNumber: text("sia_license_number"),
  siaLicenseLevel: integer("sia_license_level"),
  siaLicenseExpiry: date("sia_license_expiry"),
  previousExperience: text("previous_experience"),
  yearsExperience: integer("years_experience"),
  references: jsonb("references"),
  // Answers to admin-defined custom questions (application_questions). Stored
  // denormalized: [{ questionId, label, fieldType, value }] so HR can still
  // read historical answers even if a question is later edited or deleted.
  customAnswers: jsonb("custom_answers"),
  photoKey: text("photo_key"),
  cvKey: text("cv_key"),
  trainingCertificateKeys: jsonb("training_certificate_keys"),
  availability: jsonb("availability"),
  reviewerNotes: text("reviewer_notes"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  // Two-admin approval gate. An application must be approved by TWO distinct
  // admins before an onboarding link is issued. The first approval records
  // first_approved_by/at and flips status to "awaiting_second_approval"; the
  // second approval (which must come from a *different* admin) records
  // second_approved_by/at and finalizes status to "approved". Both columns are
  // cleared whenever the application is sent back for more info or amended, so
  // the gate always restarts from zero after applicant-side changes.
  firstApprovedBy: uuid("first_approved_by"),
  firstApprovedAt: timestamp("first_approved_at", { withTimezone: true }),
  secondApprovedBy: uuid("second_approved_by"),
  secondApprovedAt: timestamp("second_approved_at", { withTimezone: true }),
  createdEmployeeId: uuid("created_employee_id"),
  // Onboarding-approval email delivery state. Captured from the SMTP handoff
  // when the admin approves the application (and again on resend). Lets HR
  // see at a glance whether the candidate actually received their link.
  //   status: null | "not_configured" | "sent" | "bounced" | "failed"
  //   - not_configured: SMTP not set up; admin must share link manually
  //   - sent: SMTP accepted with no rejected recipients
  //   - bounced: SMTP rejected one or more recipients (response captured)
  //   - failed: transport threw (network/auth error)
  // messageId, response, error are pulled from the nodemailer result.
  onboardingEmailStatus: text("onboarding_email_status"),
  onboardingEmailMessageId: text("onboarding_email_message_id"),
  onboardingEmailResponse: text("onboarding_email_response"),
  onboardingEmailError: text("onboarding_email_error"),
  onboardingEmailSentAt: timestamp("onboarding_email_sent_at", { withTimezone: true }),
  onboardingEmailAttemptedAt: timestamp("onboarding_email_attempted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertApplicationSchema = createInsertSchema(applicationsTable).omit({
  id: true, status: true, reviewerNotes: true, reviewedBy: true, reviewedAt: true,
  createdEmployeeId: true, createdAt: true, updatedAt: true,
});
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;
