/**
 * Remote-change audit retention.
 *
 * Every successful remote brand/feature push appends a row to
 * `control_plane_remote_changes` and rows are never otherwise pruned. Over a
 * long-lived fleet that table would grow unbounded. This periodic job trims
 * rows older than a configurable window (CONTROL_PLANE_REMOTE_CHANGE_RETENTION_DAYS,
 * default 180 days). The delete is idempotent — re-running it simply removes
 * whatever has since aged past the window — and every run is logged.
 *
 * Setting the retention window to 0 (or negative) disables pruning entirely.
 */

import { REMOTE_CHANGE_RETENTION_DAYS, RETENTION_INTERVAL_MS } from "./config";
import { pool } from "./db";
import { logger } from "./logger";

/**
 * Delete remote-change rows older than the retention window once.
 *
 * Returns the number of rows deleted. A non-positive window disables pruning
 * and returns 0 without touching the table.
 */
export async function pruneRemoteChangesOnce(
  retentionDays: number = REMOTE_CHANGE_RETENTION_DAYS,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    logger.info(
      { retentionDays },
      "[retention] remote-change pruning disabled (non-positive window)",
    );
    return 0;
  }

  const { rowCount } = await pool.query(
    `DELETE FROM control_plane_remote_changes
       WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  const deleted = rowCount ?? 0;
  logger.info({ retentionDays, deleted }, "[retention] pruned remote-change rows");
  return deleted;
}

/** Floor for the retention interval, so a bad env value can't tight-loop. */
const MIN_RETENTION_INTERVAL_MS = 60_000;

export function startRetention(): void {
  const run = () => {
    pruneRemoteChangesOnce().catch((err) =>
      logger.error({ err: String(err) }, "[retention] cycle failed"),
    );
  };
  const intervalMs =
    Number.isFinite(RETENTION_INTERVAL_MS) && RETENTION_INTERVAL_MS >= MIN_RETENTION_INTERVAL_MS
      ? RETENTION_INTERVAL_MS
      : MIN_RETENTION_INTERVAL_MS;
  // First run shortly after boot, then on the interval.
  setTimeout(run, 5000);
  setInterval(run, intervalMs);
  logger.info(
    { intervalMs, retentionDays: REMOTE_CHANGE_RETENTION_DAYS },
    "[retention] started",
  );
}
