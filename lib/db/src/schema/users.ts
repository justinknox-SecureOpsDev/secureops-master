import { pgTable, text, uuid, timestamp, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  role: text("role").notNull().default("employee"),
  status: text("status").notNull().default("pending"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  mustCompleteProfile: boolean("must_complete_profile").notNull().default(false),
  // Temporary plaintext password set by admin "bulk generate" — visible only
  // to admins until the user is invited (then cleared). NEVER returned by
  // user-facing endpoints.
  tempPasswordPlain: text("temp_password_plain"),
  tempPasswordSetAt: timestamp("temp_password_set_at", { withTimezone: true }),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  expoPushToken: text("expo_push_token"),
  lastLat: numeric("last_lat", { precision: 10, scale: 6 }),
  lastLng: numeric("last_lng", { precision: 10, scale: 6 }),
  lastLocationAt: timestamp("last_location_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
