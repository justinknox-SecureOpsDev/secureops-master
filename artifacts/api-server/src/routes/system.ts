import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, schedulerSyncCursorsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { getGeofenceRadiusMiles } from "../lib/geofence";
import { isSchedulerConfigured } from "../lib/schedulerSync";
import { isLiveKitConfigured } from "../lib/livekit";
import { isPncConfigured } from "../lib/pncPayments";

/**
 * The reconciliation safety-net job pulls from the scheduler every 15 minutes.
 * If the last successful sync is older than this, the integration is treated as
 * falling behind (stalled job, repeated failures, or scheduler unreachable).
 */
const SCHEDULER_SYNC_STALE_MS = 30 * 60 * 1000;

const router: IRouter = Router();

/**
 * GET /admin/system/status — admin-only environment summary used by the
 * portal to surface degraded-mode banners (e.g. "SMTP not configured").
 *
 * Returns ONLY booleans / non-secret metadata. Never echoes any env value.
 */
router.get("/admin/system/status", requireAdmin, async (_req, res): Promise<void> => {
  const env = process.env.NODE_ENV ?? "development";
  const smtpConfigured = Boolean(
    process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS,
  );
  const sessionSecretOk = Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16);
  const baseUrlConfigured = Boolean(process.env.APP_BASE_URL || process.env.REPLIT_DOMAINS);
  const corsOriginsConfigured = Boolean(process.env.ALLOWED_ORIGINS || process.env.REPLIT_DOMAINS);
  const geofenceRadiusMiles = getGeofenceRadiusMiles();
  const geofenceRadiusTooTight = geofenceRadiusMiles > 0 && geofenceRadiusMiles < 0.05;
  const schedulerConfigured = isSchedulerConfigured();
  const livekitConfigured = isLiveKitConfigured();

  // Scheduler sync health: only meaningful when configured. Unhealthy when the
  // last run recorded an error, or no successful sync has happened within the
  // stale window (overdue — job stalled or scheduler unreachable).
  let schedulerSyncHealthy = true;
  if (schedulerConfigured) {
    const [shiftsCursor] = await db
      .select()
      .from(schedulerSyncCursorsTable)
      .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));
    const lastSyncAt = shiftsCursor?.lastSyncAt ?? null;
    const lastSyncError = shiftsCursor?.lastSyncError ?? null;
    const overdue =
      lastSyncAt === null || Date.now() - new Date(lastSyncAt).getTime() > SCHEDULER_SYNC_STALE_MS;
    schedulerSyncHealthy = lastSyncError === null && !overdue;
  }

  const pncConfigured = isPncConfigured();

  res.json({
    env,
    smtpConfigured,
    sessionSecretOk,
    baseUrlConfigured,
    corsOriginsConfigured,
    geofenceRadiusMiles,
    geofenceRadiusTooTight,
    schedulerConfigured,
    schedulerSyncHealthy,
    livekitConfigured,
    pncConfigured,
  });
});

export default router;
