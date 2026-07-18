/**
 * Super-admin platform-control routes.
 *
 * Today: runtime feature-flag overrides backed by
 * `platform_feature_overrides`. Tomorrow: brand swap, tier preset, etc.
 *
 * Access: limited to emails listed in `SUPER_ADMIN_EMAILS` (CSV env). If
 * unset, falls back to the seeded brand admin account so a fresh deployment
 * works out-of-the-box.
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod/v4";
import { eq, sql } from "drizzle-orm";
import { db, platformFeatureOverridesTable, platformCustomerConfigTable, platformBrandConfigTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { brand, applyBrandOverrides } from "../lib/brandConfig";
import {
  type FeatureKey,
  getFeatureFlagDetails,
  loadFeatureOverridesFromDb,
  setOverrideInMemory,
  clearOverrideInMemory,
} from "../lib/features";
import { featureUpdateBody, brandConfigSchema } from "../lib/platformSchemas";

const router: Router = Router();

// Super-admin is a *separate* identity from day-to-day admin. Regular
// admins deliberately do NOT see this surface — only the dedicated platform
// owner account does. Override via SUPER_ADMIN_EMAILS env (CSV). Falls back
// to the seeded brand admin so the platform is reachable out-of-the-box.
const SUPER_ADMIN_EMAILS = new Set(
  (process.env["SUPER_ADMIN_EMAILS"] ?? brand.demoAdminEmail)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const requireSuperAdmin: RequestHandler = (req, res, next) => {
  const email = req.user?.email?.toLowerCase();
  if (!email || !SUPER_ADMIN_EMAILS.has(email)) {
    res.status(403).json({ error: "Forbidden", message: "Super-admin access required." });
    return;
  }
  next();
};

router.get("/admin/platform/features", requireAuth, requireSuperAdmin, (_req, res) => {
  res.json({ features: getFeatureFlagDetails() });
});

router.put("/admin/platform/features", requireAuth, requireSuperAdmin, async (req, res) => {
  const parsed = featureUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = req.user?.email ?? "unknown";

  for (const u of parsed.data.updates) {
    const key = u.key as FeatureKey;
    if (u.enabled === null) {
      await db.delete(platformFeatureOverridesTable)
        .where(eq(platformFeatureOverridesTable.featureKey, key));
      clearOverrideInMemory(key);
    } else {
      // Upsert — keep one row per feature key.
      await db.insert(platformFeatureOverridesTable)
        .values({ featureKey: key, enabled: u.enabled, updatedBy: editor })
        .onConflictDoUpdate({
          target: platformFeatureOverridesTable.featureKey,
          set: { enabled: u.enabled, updatedBy: editor, updatedAt: sql`now()` },
        });
      setOverrideInMemory(key, u.enabled);
    }
  }
  // Reload from DB to stay consistent if another instance also wrote.
  await loadFeatureOverridesFromDb();
  res.json({ features: getFeatureFlagDetails() });
});

/** Tells the admin portal whether the current user can see the platform tab. */
router.get("/admin/platform/me", requireAuth, (req, res) => {
  const email = req.user?.email?.toLowerCase();
  res.json({ isSuperAdmin: !!email && SUPER_ADMIN_EMAILS.has(email) });
});

/** Returns the current customer plan / commercial config for this deployment. */
router.get("/admin/platform/customer-config", requireAuth, requireSuperAdmin, async (_req, res) => {
  const [config] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
  res.json({ config: config ?? null });
});

const customerConfigSchema = z.object({
  customerName: z.string().max(200).nullable(),
  planTier: z.enum(["starter", "professional", "enterprise", "custom"]).nullable(),
  monthlyPriceCents: z.number().int().min(0).nullable(),
  officerCount: z.number().int().min(1).nullable(),
  billingNotes: z.string().max(2000).nullable(),
  planStartDate: z.string().nullable(),
});

/** Upserts the customer plan / commercial config for this deployment. */
router.put("/admin/platform/customer-config", requireAuth, requireSuperAdmin, async (req, res) => {
  const parsed = customerConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = req.user?.email ?? "unknown";
  const { customerName, planTier, monthlyPriceCents, officerCount, billingNotes, planStartDate } = parsed.data;

  await db
    .insert(platformCustomerConfigTable)
    .values({ id: "singleton", customerName, planTier, monthlyPriceCents, officerCount, billingNotes, planStartDate, updatedBy: editor })
    .onConflictDoUpdate({
      target: platformCustomerConfigTable.id,
      set: { customerName, planTier, monthlyPriceCents, officerCount, billingNotes, planStartDate, updatedBy: editor, updatedAt: sql`now()` },
    });

  const [config] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
  res.json({ config });
});

/** Returns the current brand override row (raw nulls so the UI shows env defaults as placeholders). */
router.get("/admin/platform/brand", requireAuth, requireSuperAdmin, async (_req, res) => {
  const [config] = await db
    .select()
    .from(platformBrandConfigTable)
    .where(eq(platformBrandConfigTable.id, "singleton"))
    .limit(1);
  res.json({ config: config ?? null });
});

/** Upserts the per-deployment brand overrides and applies them to the live brand in memory. */
router.put("/admin/platform/brand", requireAuth, requireSuperAdmin, async (req, res) => {
  const parsed = brandConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = req.user?.email ?? "unknown";
  const d = parsed.data;

  await db
    .insert(platformBrandConfigTable)
    .values({ id: "singleton", ...d, updatedBy: editor })
    .onConflictDoUpdate({
      target: platformBrandConfigTable.id,
      set: { ...d, updatedBy: editor, updatedAt: sql`now()` },
    });

  const [config] = await db
    .select()
    .from(platformBrandConfigTable)
    .where(eq(platformBrandConfigTable.id, "singleton"))
    .limit(1);

  // Patch the live brand so emails, PDFs, and /api/brand reflect the change
  // immediately without a restart.
  applyBrandOverrides(config ?? null);
  res.json({ config });
});

export default router;
