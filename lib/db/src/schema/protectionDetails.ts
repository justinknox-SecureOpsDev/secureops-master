import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";

/**
 * Executive / close-protection ("PPO Detail") pre-plan for a single shift.
 *
 * 1:1 with a shift (enforced by the unique index on shiftId). Holds the
 * free-text operational plan an admin/dispatcher prepares ahead of a
 * protection detail; the assigned officer reads it on mobile. Every field is
 * optional — a half-filled package is valid. Highly sensitive: only readable
 * by admins/dispatchers/leads and officers with an ACCEPTED assignment to the
 * shift, never on public/share surfaces.
 */
export const protectionDetailsTable = pgTable("protection_details", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => shiftsTable.id, { onDelete: "cascade" }),
  // low | medium | high | critical (free-text, optional).
  threatLevel: text("threat_level"),
  missionSummary: text("mission_summary"),
  dressCode: text("dress_code"),
  armamentInstructions: text("armament_instructions"),
  communicationPlan: text("communication_plan"),
  medicalNotes: text("medical_notes"),
  emergencyRendezvous: text("emergency_rendezvous"),
  vehicleDetails: text("vehicle_details"),
  specialInstructions: text("special_instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // One protection plan per shift.
  shiftUnique: uniqueIndex("protection_details_shift_unique").on(t.shiftId),
}));

export const insertProtectionDetailSchema = createInsertSchema(protectionDetailsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProtectionDetail = z.infer<typeof insertProtectionDetailSchema>;
export type ProtectionDetail = typeof protectionDetailsTable.$inferSelect;
