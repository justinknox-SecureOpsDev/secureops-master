/**
 * External operator control-plane routes.
 *
 * Authenticated via HMAC-SHA256 over the exact raw request body bytes
 * (or the empty string for body-less requests), using the
 * CONTROL_PLANE_SHARED_SECRET environment variable.  This mirrors the
 * scheduler-webhook HMAC pattern (same `verifySignature` helper,
 * same `req.rawBody` populated by the express.json `verify` callback in
 * app.ts).
 *
 * Routes:
 *   GET  /control-plane/settings   — deployment info, live brand, feature flags
 *   PUT  /control-plane/brand      — upsert the platform brand singleton + re-apply live
 *   PUT  /control-plane/features   — upsert / clear feature-flag overrides
 *
 * If CONTROL_PLANE_SHARED_SECRET is not set the whole surface returns 503.
 * A missing or invalid signature returns 401 via constant-time comparison.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, platformBrandConfigTable } from "@workspace/db";
import { verifySignature } from "../lib/schedulerSync";
import { brand, BrandUpdateSchema, applyBrandRow } from "../lib/brandConfig";
import { getFlags, applyFlagsUpdate, FeatureFlagsUpdateSchema } from "../lib/featureFlags";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Captured once at module load — used as a stable `builtAt` proxy. */
const SERVER_STARTED_AT = new Date().toISOString();

// ---------------------------------------------------------------------------
// HMAC authentication middleware — shared by all three routes
// ---------------------------------------------------------------------------
function requireControlPlaneHmac(req: Request, res: Response, next: NextFunction): void {
  const secret = (process.env.CONTROL_PLANE_SHARED_SECRET ?? "").trim();
  if (!secret) {
    res.status(503).json({
      error: "Service Unavailable",
      message: "Control-plane integration not configured (CONTROL_PLANE_SHARED_SECRET not set)",
    });
    return;
  }
  // For GET (body-less) requests, rawBody is an empty string "".
  // For PUT requests, rawBody holds the exact bytes the client sent.
  const rawBody: string = (req as any).rawBody ?? "";
  const sig = req.headers["x-control-plane-signature"] as string | undefined;
  if (!verifySignature(rawBody, sig, secret)) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or missing HMAC signature" });
    return;
  }
  next();
}

router.use("/control-plane", requireControlPlaneHmac);

// ---------------------------------------------------------------------------
// GET /control-plane/settings
// ---------------------------------------------------------------------------
router.get("/control-plane/settings", async (_req: Request, res: Response): Promise<void> => {
  try {
    const features = await getFlags();
    res.json({
      version:  process.env.npm_package_version ?? "0.0.0",
      builtAt:  SERVER_STARTED_AT,
      brand:    { ...brand },
      features,
    });
  } catch (err) {
    logger.error({ err }, "[control-plane] GET /settings failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /control-plane/brand
// ---------------------------------------------------------------------------
router.put("/control-plane/brand", async (req: Request, res: Response): Promise<void> => {
  const parsed = BrandUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const data = parsed.data;

  try {
    const row = {
      id: "singleton" as const,
      ...(data.companyName          != null && { companyName:          data.companyName }),
      ...(data.shortName            != null && { shortName:            data.shortName }),
      ...(data.tagline              != null && { tagline:              data.tagline }),
      ...(data.appName              != null && { appName:              data.appName }),
      ...(data.colorNavy            != null && { colorNavy:            data.colorNavy }),
      ...(data.colorGold            != null && { colorGold:            data.colorGold }),
      ...(data.colorCream           != null && { colorCream:           data.colorCream }),
      ...(data.billingEmail         != null && { billingEmail:         data.billingEmail }),
      ...(data.hrEmail              != null && { hrEmail:              data.hrEmail }),
      ...(data.adminNotifyEmail     != null && { adminNotifyEmail:     data.adminNotifyEmail }),
      ...(data.privacyEmail         != null && { privacyEmail:         data.privacyEmail }),
      ...(data.demoAdminEmail       != null && { demoAdminEmail:       data.demoAdminEmail }),
      ...(data.demoAdminPassword    != null && { demoAdminPassword:    data.demoAdminPassword }),
      ...(data.demoEmployeeEmail    != null && { demoEmployeeEmail:    data.demoEmployeeEmail }),
      ...(data.demoEmployeePassword != null && { demoEmployeePassword: data.demoEmployeePassword }),
      ...(data.demoLeadEmail        != null && { demoLeadEmail:        data.demoLeadEmail }),
      ...(data.demoLeadPassword     != null && { demoLeadPassword:     data.demoLeadPassword }),
    };

    await db
      .insert(platformBrandConfigTable)
      .values(row)
      .onConflictDoUpdate({
        target: platformBrandConfigTable.id,
        set: { ...row, updatedAt: new Date() },
      });

    const [updated] = await db
      .select()
      .from(platformBrandConfigTable)
      .where(eq(platformBrandConfigTable.id, "singleton"))
      .limit(1);

    if (updated) applyBrandRow(updated);

    logger.info({ fields: Object.keys(data) }, "[control-plane] brand updated");
    res.json({ ok: true, brand: { ...brand } });
  } catch (err) {
    logger.error({ err }, "[control-plane] PUT /brand failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /control-plane/features
// ---------------------------------------------------------------------------
router.put("/control-plane/features", async (req: Request, res: Response): Promise<void> => {
  const parsed = FeatureFlagsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }

  try {
    await applyFlagsUpdate(parsed.data);
    const features = await getFlags();
    logger.info(
      {
        upserted: parsed.data.flags?.length ?? 0,
        cleared:  parsed.data.clear?.length ?? 0,
      },
      "[control-plane] features updated",
    );
    res.json({ ok: true, features });
  } catch (err) {
    logger.error({ err }, "[control-plane] PUT /features failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
