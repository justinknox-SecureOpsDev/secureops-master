import { Router, type IRouter } from "express";
import { requireAdmin } from "../middlewares/auth";
import { getGeofenceRadiusMiles } from "../lib/geofence";
import { isSchedulerConfigured } from "../lib/schedulerSync";

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
  res.json({
    env,
    smtpConfigured,
    sessionSecretOk,
    baseUrlConfigured,
    corsOriginsConfigured,
    geofenceRadiusMiles,
    geofenceRadiusTooTight,
    schedulerConfigured,
  });
});

export default router;
