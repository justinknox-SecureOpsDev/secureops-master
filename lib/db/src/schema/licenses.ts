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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLicenseSchema = createInsertSchema(licensesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLicense = z.infer<typeof insertLicenseSchema>;
export type License = typeof licensesTable.$inferSelect;
