import { pgTable, text, uuid, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shiftsTable } from "./shifts";

/**
 * A person on a protection detail: either a PRINCIPAL (the person being
 * protected) or a THREAT/subject of interest (someone to watch for). One table
 * with a `kind` discriminator instead of two parallel tables — the field set is
 * identical and the read/write/authz path is shared.
 *
 * All fields are optional. `photoKeys` are object-storage paths (same shape as
 * incidents.attachments) — private uploads readable only by admins or an
 * officer with an accepted assignment to the parent shift (gated server-side in
 * /me/storage/sign). Demographics + threat notes are sensitive PII and must
 * never appear on public/share surfaces or in raw audit-log snapshots.
 */
export const protectionPersonsTable = pgTable("protection_persons", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => shiftsTable.id, { onDelete: "cascade" }),
  // 'principal' | 'threat'
  kind: text("kind").notNull(),
  // Display ordering within a kind.
  seq: integer("seq").notNull().default(0),
  name: text("name"),
  // Principal: role/relationship ("CEO", "spouse"). Threat: relationship to
  // principal ("former employee", "unknown").
  relationship: text("relationship"),
  // Optional demographics — free-text so partial descriptions are valid.
  sex: text("sex"),
  age: text("age"),
  height: text("height"),
  weight: text("weight"),
  hairColor: text("hair_color"),
  eyeColor: text("eye_color"),
  distinguishingFeatures: text("distinguishing_features"),
  // Principal: handling/special instructions. Threat: behavior, history,
  // restraining orders, last-known whereabouts.
  notes: text("notes"),
  // Object-storage paths for uploaded photos.
  photoKeys: jsonb("photo_keys").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  shiftIdx: index("protection_persons_shift_idx").on(t.shiftId),
}));

export const insertProtectionPersonSchema = createInsertSchema(protectionPersonsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProtectionPerson = z.infer<typeof insertProtectionPersonSchema>;
export type ProtectionPerson = typeof protectionPersonsTable.$inferSelect;
