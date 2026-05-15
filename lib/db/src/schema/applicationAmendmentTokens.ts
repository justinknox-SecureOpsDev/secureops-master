import { pgTable, text, uuid, timestamp, jsonb } from "drizzle-orm/pg-core";
import { applicationsTable } from "./applications";

export const applicationAmendmentTokensTable = pgTable("application_amendment_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  applicationId: uuid("application_id").notNull().references(() => applicationsTable.id, { onDelete: "cascade" }),
  requestedFields: jsonb("requested_fields").notNull(),
  note: text("note"),
  requestedBy: uuid("requested_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ApplicationAmendmentToken = typeof applicationAmendmentTokensTable.$inferSelect;
