/**
 * Company-owner flag helpers.
 *
 * `isCompanyOwner` is a boolean on `users`, INDEPENDENT of `role` and of the
 * permission matrix (lib/permissions.ts). It gates ONLY the company-wide
 * financial dashboards (revenue/margin/profit KPIs, payroll & invoice
 * aggregate totals/exports) — never platform-level super-admin, which stays
 * entirely env-driven via SUPER_ADMIN_EMAILS (routes/platform.ts) and is
 * completely out of reach of anything in this file.
 *
 * Grant/revoke enforcement lives in routes/companyOwners.ts (only an
 * existing owner may change another user's flag; the last remaining owner
 * can never be revoked). This module holds the shared count/backfill
 * queries so both the route and the boot backfill use the same source of
 * truth.
 */

import { and, count, eq } from "drizzle-orm";
import { db, usersTable, companyOwnerRolloutTable } from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function countCompanyOwners(executor: typeof db | Tx = db): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(usersTable)
    .where(and(eq(usersTable.isCompanyOwner, true), eq(usersTable.status, "active")));
  return row?.n ?? 0;
}

/**
 * Row-locking variant of `countCompanyOwners`, for use inside a transaction
 * that is about to revoke someone's flag. `SELECT ... FOR UPDATE` cannot be
 * combined with an aggregate, so this selects the matching ids and counts
 * them in JS — the important part is that it takes a row lock on every
 * currently-active-owner row. Two concurrent revoke transactions targeting
 * different owners then serialize on the overlapping lock: the second
 * transaction blocks until the first commits, and on resume re-evaluates the
 * WHERE clause against the now-committed data, so it correctly sees the
 * reduced owner count instead of a stale snapshot. This is what makes the
 * "never revoke the last owner" invariant race-safe under concurrent calls.
 */
export async function countCompanyOwnersForUpdate(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.isCompanyOwner, true), eq(usersTable.status, "active")))
    .for("update");
  return rows.length;
}

/**
 * Decides whether a backfill attempt is allowed to permanently claim its
 * one-time marker. Pure so the pending/retry edge case (see below) can be
 * unit-tested without touching any DB state.
 *
 * Claim once the rollout has actually produced a result: either this call
 * just promoted at least one admin (`updatedCount > 0`), or the deployment
 * already had at least one owner before this call ran (`existingOwnerCount
 * > 0` — e.g. a re-run after the rollout already succeeded once, or an
 * owner was set up some other way). If NEITHER holds, there is nothing to
 * show for this attempt — most likely because zero admin-role users exist
 * in the database yet — so the marker must stay unclaimed and a later call
 * (the next boot) has to retry.
 */
export function shouldClaimCompanyOwnerRollout(updatedCount: number, existingOwnerCount: number): boolean {
  return updatedCount > 0 || existingOwnerCount > 0;
}

/**
 * One-time rollout backfill: every admin-role user becomes a company owner
 * so no deployment is ever locked out of financial dashboards once this
 * feature ships. Called on every boot (see index.ts, chained after
 * `seedDemoUsers()`); safe and cheap to no-op on every call after it first
 * succeeds.
 *
 * This must run EXACTLY ONCE EVER *for the rows it actually touches*, not
 * "once per row" — an owner may deliberately revoke the flag from a user
 * who remains an admin, and that revocation has to stick across every
 * future restart. A per-row condition like "role = admin AND
 * is_company_owner = false" would silently undo that revocation on the
 * very next boot, which is a real access-control bug, not just an
 * idempotency nicety.
 *
 * But "once ever" cannot mean "on the very first call, no matter what it
 * found" either: on a brand-new database the very first boot can run before
 * any admin-role user exists yet (`SEED_DEMO_USERS=false`, seeding not yet
 * configured, or a seeding failure). If that first call permanently claimed
 * the marker regardless of outcome, the eventual first admin — created
 * moments, hours, or boots later — would never be auto-granted ownership,
 * and there would be no existing owner left to grant it to them manually
 * either: a permanent lockout with no in-product recovery path.
 *
 * So the marker is claimed via `shouldClaimCompanyOwnerRollout` above: a
 * call that finds nothing to do AND no pre-existing owner leaves the
 * marker unclaimed and simply retries on the next boot — cheap (one
 * SELECT + one no-op UPDATE) since it only happens while the deployment
 * has literally zero owners. The moment an admin exists on any later boot,
 * that boot's call succeeds and permanently closes the rollout.
 *
 * `markerId` defaults to the real production singleton and should never be
 * overridden outside tests; tests pass a unique id to exercise the
 * claim/no-op behavior in isolation from the real one-time rollout.
 *
 * Returns the number of rows updated (0 once the rollout has succeeded, or
 * on every call before an admin exists yet).
 */
export async function backfillCompanyOwnersFromAdminRole(markerId = "singleton"): Promise<number> {
  return db.transaction(async (tx) => {
    const [existingMarker] = await tx
      .select({ id: companyOwnerRolloutTable.id })
      .from(companyOwnerRolloutTable)
      .where(eq(companyOwnerRolloutTable.id, markerId));
    if (existingMarker) {
      // Already succeeded once — never re-run, regardless of current flags.
      return 0;
    }

    const updated = await tx
      .update(usersTable)
      .set({ isCompanyOwner: true })
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.isCompanyOwner, false)))
      .returning({ id: usersTable.id });

    const existingOwnerCount = await countCompanyOwners(tx);
    if (!shouldClaimCompanyOwnerRollout(updated.length, existingOwnerCount)) {
      // Nothing to show for this attempt (no admins exist yet) — stay
      // pending so a later boot, once an admin finally exists, retries.
      return 0;
    }

    await tx.insert(companyOwnerRolloutTable).values({ id: markerId }).onConflictDoNothing();
    return updated.length;
  });
}
