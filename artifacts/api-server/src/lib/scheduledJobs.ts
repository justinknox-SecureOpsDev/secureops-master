import { lt } from "drizzle-orm";
import { db, revokedTokensTable } from "@workspace/db";
import { logger } from "./logger";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Once every `intervalMs` (default: 1 hour) delete every row in
 * `revoked_tokens` whose JWT has already expired. Expired entries have no
 * security value — `verifyToken()` already rejects them — but they make the
 * per-request lookup in `requireAuth` slowly more expensive as the table
 * grows. Logging the row count lets operators confirm the job is running.
 *
 * The cleanup runs once at startup and then on the interval, so a freshly
 * deployed instance does not have to wait an hour to compact stale data.
 * Errors are caught and logged so a transient DB issue cannot crash the
 * server loop.
 */
export function startScheduledJobs(intervalMs: number = HOUR_MS): NodeJS.Timeout {
  async function cleanupExpiredRevokedTokens(): Promise<void> {
    try {
      const now = new Date();
      // Avoid `RETURNING *` — on a large table that materializes every
      // expired row just to count it. We rely on the driver's `rowCount`
      // instead so the DB only ships the deletion summary.
      const result = await db
        .delete(revokedTokensTable)
        .where(lt(revokedTokensTable.expiresAt, now));
      const removed = (result as { rowCount?: number | null }).rowCount ?? 0;
      if (removed > 0) {
        logger.info({ removed }, "Cleaned up expired revoked tokens");
      }
    } catch (err) {
      logger.error({ err }, "Failed to clean up revoked tokens");
    }
  }

  // Run immediately so a long-lived deployment does not have to wait for the
  // first tick after boot.
  void cleanupExpiredRevokedTokens();
  const handle = setInterval(() => void cleanupExpiredRevokedTokens(), intervalMs);
  // Don't keep the event loop alive for this timer alone.
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}
