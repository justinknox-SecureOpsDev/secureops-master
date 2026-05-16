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
  siaLicenseNumber: text("sia_license_number"),
  siaLicenseLevel: integer("sia_license_level"),
  siaLicenseExpiry: date("sia_license_expiry"),
  previousExperience: text("previous_experience"),
  yearsExperience: integer("years_experience"),
  references: jsonb("references"),
  photoKey: text("photo_key"),
  cvKey: text("cv_key"),
  trainingCertificateKeys: jsonb("training_certificate_keys"),
  availability: jsonb("availability"),
  reviewerNotes: text("reviewer_notes"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdEmployeeId: uuid("created_employee_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertApplicationSchema = createInsertSchema(applicationsTable).omit({
  id: true, status: true, reviewerNotes: true, reviewedBy: true, reviewedAt: true,
  createdEmployeeId: true, createdAt: true, updatedAt: true,
});
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;
