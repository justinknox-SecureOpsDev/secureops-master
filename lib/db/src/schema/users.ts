import { pgTable, text, uuid, timestamp, numeric, boolean, jsonb } from "drizzle-orm/pg-core";
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
  // Sessions issued before this timestamp are rejected. Bumped on
  // self-logout-all-devices and admin "revoke all sessions" actions.
  tokensValidAfter: timestamp("tokens_valid_after", { withTimezone: true }).notNull().defaultNow(),
  expoPushToken: text("expo_push_token"),
  // E.164 phone number for SMS notifications (e.g. "+15125550142"). Optional —
  // SMS only fires when this is set AND smsOptIn is true AND Twilio is connected.
  phoneNumber: text("phone_number"),
  smsOptIn: boolean("sms_opt_in").notNull().default(true),
  // TOTP (RFC 6238) two-factor secret. Currently stored unencrypted so
  // the design stays simple; rotating SESSION_SECRET-derived AES is a
  // future hardening step. Only present once the user has enrolled.
  totpSecret: text("totp_secret"),
  totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),
  // Bcrypt-hashed recovery codes (10 single-use codes generated on
  // enrollment). Stored as a JSON array of strings; consumed entries are
  // removed on use.
  totpRecoveryCodes: jsonb("totp_recovery_codes").$type<string[]>(),
  lastLat: numeric("last_lat", { precision: 10, scale: 6 }),
  lastLng: numeric("last_lng", { precision: 10, scale: 6 }),
  lastLocationAt: timestamp("last_location_at", { withTimezone: true }),
  // Wall-clock of the most recent authenticated REST/WS request from this
  // user. Updated by `requireAuth` at most once per ~60s/user (in-memory
  // throttle) so it never becomes a per-request hot write. Used by admins
  // to decide whether revoking sessions is meaningful right now.
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  // Set the first time the user ever successfully completes /auth/login
  // (or /auth/login-totp). Stays sticky after that. Powers the "NEW"
  // pill on the admin personnel list so admins can tell at a glance
  // which freshly-onboarded officers have actually started using the app.
  firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
  // Updated every successful login. Distinct from `lastActiveAt`, which
  // tracks any authenticated request — `lastLoginAt` is only the password
  // exchange itself, so it's a useful signal of "they re-entered creds".
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
