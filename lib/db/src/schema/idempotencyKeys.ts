import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Durable replay protection for writes that are not naturally idempotent.
 *
 * One row per protected write, created BEFORE the route runs and completed
 * with that route's own answer. A retry carrying the same idempotency key is
 * answered from this row instead of performing the work a second time — see
 * artifacts/api-server/src/lib/idempotency.ts for the full contract.
 *
 * It lives in the database rather than in process memory because the window it
 * covers spans exactly the events that lose memory: a redeploy or crash
 * between an interrupted request and its retry, and a retry that lands on a
 * different instance of the API. Both used to leave the caller with "I cannot
 * tell you whether that went through".
 *
 * Rows are short-lived. A recorded outcome is swept once `expiresAt` passes
 * (ten minutes); a row whose write never produced an outcome is deliberately
 * NOT swept, because deleting it is what would let a retry apply the change
 * twice.
 */
export const idempotencyKeysTable = pgTable("idempotency_keys", {
  /**
   * SHA-256 of actor + method + path + key. Hashing keeps the primary key a
   * fixed size no matter how long the request path or the caller's key is,
   * while still being derived from exactly those four parts — the plain
   * columns below carry the same values for anyone reading the table.
   */
  scopeHash: text("scope_hash").primaryKey(),
  /** The signed-in user's id, or "anonymous". One person's key never replays another's answer. */
  actor: text("actor").notNull(),
  method: text("method").notNull(),
  /** Request path without its query string. */
  path: text("path").notNull(),
  /** The key exactly as the caller supplied it. */
  idempotencyKey: text("idempotency_key").notNull(),
  /** NULL while the write is still running; the route's own status code once it answered. */
  status: integer("status"),
  /** The route's own JSON answer, replayed verbatim to a retry. */
  body: jsonb("body"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /** When a recorded outcome stops being replayable. Ignored while `status` is NULL. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  expiresIdx: index("idempotency_keys_expires_idx").on(t.expiresAt),
}));

export type IdempotencyKeyRecord = typeof idempotencyKeysTable.$inferSelect;
