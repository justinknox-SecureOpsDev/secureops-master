import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const revokedTokensTable = pgTable("revoked_tokens", {
  jti: text("jti").primaryKey(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull().default("logout"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  userIdx: index("revoked_tokens_user_idx").on(t.userId),
  expiresIdx: index("revoked_tokens_expires_idx").on(t.expiresAt),
}));

export type RevokedToken = typeof revokedTokensTable.$inferSelect;
