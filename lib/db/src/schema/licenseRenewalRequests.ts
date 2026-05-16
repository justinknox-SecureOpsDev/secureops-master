import { pgTable, text, uuid, timestamp, integer, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { licensesTable } from "./licenses";

/**
 * Officer-submitted license renewal awaiting admin approval.
 *
 * Lifecycle:
 *   pending → admin approves → approved (terminal — licenses row inserted/updated)
 *           → admin rejects  → rejected (terminal)
 *
 * `licenseId` is set when renewing an existing license (admin will update
 * that row's number/dates/level on approval); when null we treat it as a
 * brand-new license and insert a fresh row on approval.
 */
export const licenseRenewalRequestsTable = pgTable("license_renewal_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  licenseId: uuid("license_id").references(() => licensesTable.id, { onDelete: "set null" }),
  licenseType: text("license_type").notNull(),
  licenseLevel: integer("license_level"),
  licenseNumber: text("license_number").notNull(),
  issuingAuthority: text("issuing_authority"),
  issueDate: date("issue_date"),
  expiryDate: date("expiry_date").notNull(),
  docKey: text("doc_key").notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("pending"),
  decisionNote: text("decision_note"),
  adminReviewerId: uuid("admin_reviewer_id").references(() => usersTable.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  employeeStatusIdx: index("license_renewal_employee_status_idx").on(t.employeeId, t.status),
  statusCreatedIdx: index("license_renewal_status_created_idx").on(t.status, t.createdAt),
  // Authoritative concurrency guard: at most one pending renewal per
  // (employee, license). Brand-new submissions (licenseId IS NULL) are
  // intentionally excluded so an officer can stack multiple new-license
  // submissions if needed.
  onePendingPerLicense: uniqueIndex("license_renewal_one_pending_per_license_idx")
    .on(t.employeeId, t.licenseId)
    .where(sql`status = 'pending' AND license_id IS NOT NULL`),
}));

export const insertLicenseRenewalRequestSchema = createInsertSchema(licenseRenewalRequestsTable).omit({
  id: true, createdAt: true, updatedAt: true, decidedAt: true,
  adminReviewerId: true, status: true, decisionNote: true,
});
export type InsertLicenseRenewalRequest = z.infer<typeof insertLicenseRenewalRequestSchema>;
export type LicenseRenewalRequest = typeof licenseRenewalRequestsTable.$inferSelect;
