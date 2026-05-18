import { pgTable, text, uuid, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Saved-progress drafts for the public officer application wizard.
 * Identified by an opaque high-entropy token that the applicant gets
 * emailed as a one-click "resume your application" link.
 *
 * - `token` is the only credential needed to read/write the draft, so
 *   it MUST be high-entropy (>=32 random bytes, base64url-encoded).
 * - `data` stores the entire wizard form snapshot (jsonb), including
 *   any `UploadedFile` references (objectPath + name + contentType +
 *   size) so previously uploaded documents reattach on resume.
 * - `step` is the last wizard step the applicant was on, so resume
 *   drops them exactly where they left off.
 * - `email` is denormalized from the form payload so we can rate-limit
 *   send / resend by (ip + email) and so cleanup logs make sense.
 * - Expired drafts (`expiresAt < now()`) are pruned hourly by the
 *   scheduled-jobs sweep; the storage objects they reference fall back
 *   to the normal anonymous-upload lifetime.
 */
export const applicationDraftsTable = pgTable(
  "application_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    email: text("email").notNull(),
    step: integer("step").notNull().default(0),
    data: jsonb("data").notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index("application_drafts_email_idx").on(t.email),
    index("application_drafts_expires_at_idx").on(t.expiresAt),
  ],
);

export type ApplicationDraft = typeof applicationDraftsTable.$inferSelect;
