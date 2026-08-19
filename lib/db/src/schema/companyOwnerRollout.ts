import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable one-time marker for the Task #733 rollout backfill that granted
 * every then-current admin the `users.is_company_owner` flag.
 *
 * A single singleton row (`id = "singleton"`) is inserted via
 * `INSERT ... ON CONFLICT DO NOTHING` the first time the backfill runs
 * successfully (see `backfillCompanyOwnersFromAdminRole` in
 * artifacts/api-server/src/lib/companyOwner.ts). Every later boot sees the
 * row already present and skips the backfill entirely.
 *
 * This must NOT be a per-row condition on `users` (e.g. "admin AND flag is
 * false") — that would silently re-grant the flag to an admin whose owner
 * status was later deliberately revoked, undoing the revocation on every
 * restart. The marker makes the backfill run exactly once, ever.
 */
export const companyOwnerRolloutTable = pgTable("company_owner_rollout", {
  id: text("id").primaryKey(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CompanyOwnerRollout = typeof companyOwnerRolloutTable.$inferSelect;
