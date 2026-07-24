/**
 * Remote control-plane management surface (HMAC-authenticated).
 *
 * The master control plane manages this customer's white-label brand and
 * feature flags WITHOUT an operator logging into the in-app super-admin UI.
 * Every route here is gated by `requireControlPlaneHmac` (HMAC-SHA256 over the
 * raw body, keyed on CONTROL_PLANE_SHARED_SECRET) and is INERT (503) until that
 * secret is provisioned on this deployment.
 *
 * It deliberately writes through the SAME tables, SAME zod validation, and SAME
 * in-memory `applyBrandOverrides()` patch as routes/platform.ts, so a remote
 * change is indistinguishable from an in-app super-admin change and takes
 * effect immediately (no restart).
 *
 * Mounted before the JWT auth middleware (it carries its own auth), alongside
 * the other HMAC webhook surfaces.
 */

import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  platformFeatureOverridesTable,
  platformBrandConfigTable,
  platformAgreementSignaturesTable,
} from "@workspace/db";
import { AGREEMENT_SLOTS, AGREEMENT_TITLES } from "@workspace/legal-docs";
import { applyBrandOverrides } from "../lib/brandConfig";
import {
  type FeatureKey,
  getFeatureFlagDetails,
  loadFeatureOverridesFromDb,
  setOverrideInMemory,
  clearOverrideInMemory,
} from "../lib/features";
import { featureUpdateBody, brandConfigSchema } from "../lib/platformSchemas";
import { requireControlPlaneHmac } from "../lib/controlPlaneAuth";
import { BUILD_VERSION, BUILD_TIME } from "../lib/buildInfo";

const router: Router = Router();

// Every route under /control-plane requires a valid HMAC signature.
router.use("/control-plane", requireControlPlaneHmac);

async function readBrandRow() {
  const [config] = await db
    .select()
    .from(platformBrandConfigTable)
    .where(eq(platformBrandConfigTable.id, "singleton"))
    .limit(1);
  return config ?? null;
}

/** Read the current managed settings: brand override row + feature flags + build identity. */
router.get("/control-plane/settings", async (_req, res) => {
  const brandRow = await readBrandRow();
  res.json({
    version: BUILD_VERSION,
    builtAt: BUILD_TIME,
    brand: brandRow,
    features: getFeatureFlagDetails(),
  });
});

/**
 * Read-only signed-status of this customer's platform agreements (MSA + User
 * Agreement). The fleet operator uses this to see which tenants have executed
 * their agreements — and whether the personal guaranty was signed — before
 * enabling paid service. Deliberately returns ONLY status metadata, never the
 * agreement document text or fill values.
 */
router.get("/control-plane/agreements", async (_req, res) => {
  const agreements: Record<string, unknown> = {};
  for (const slot of AGREEMENT_SLOTS) {
    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.slot, slot))
      .orderBy(
        desc(platformAgreementSignaturesTable.signedAt),
        desc(platformAgreementSignaturesTable.id),
      )
      .limit(1);
    agreements[slot] = {
      title: AGREEMENT_TITLES[slot],
      signed: Boolean(row),
      signedAt: row?.signedAt ?? null,
      signerName: row?.signerName ?? null,
      signerTitle: row?.signerTitle ?? null,
      signerEmail: row?.signerEmail ?? null,
      documentSha256: row?.documentSha256 ?? null,
      guarantyExecuted: slot === "msa" ? Boolean(row?.guarantorName) : null,
    };
  }
  res.json({ agreements });
});

/** Upsert brand overrides remotely and patch the live brand in memory. */
router.put("/control-plane/brand", async (req, res) => {
  const parsed = brandConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = "control-plane";
  const d = parsed.data;

  await db
    .insert(platformBrandConfigTable)
    .values({ id: "singleton", ...d, updatedBy: editor })
    .onConflictDoUpdate({
      target: platformBrandConfigTable.id,
      set: { ...d, updatedBy: editor, updatedAt: sql`now()` },
    });

  const config = await readBrandRow();
  applyBrandOverrides(config);
  res.json({ brand: config });
});

/** Upsert / clear feature-flag overrides remotely. */
router.put("/control-plane/features", async (req, res) => {
  const parsed = featureUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = "control-plane";

  for (const u of parsed.data.updates) {
    const key = u.key as FeatureKey;
    if (u.enabled === null) {
      await db
        .delete(platformFeatureOverridesTable)
        .where(eq(platformFeatureOverridesTable.featureKey, key));
      clearOverrideInMemory(key);
    } else {
      await db
        .insert(platformFeatureOverridesTable)
        .values({ featureKey: key, enabled: u.enabled, updatedBy: editor })
        .onConflictDoUpdate({
          target: platformFeatureOverridesTable.featureKey,
          set: { enabled: u.enabled, updatedBy: editor, updatedAt: sql`now()` },
        });
      setOverrideInMemory(key, u.enabled);
    }
  }
  await loadFeatureOverridesFromDb();
  res.json({ features: getFeatureFlagDetails() });
});

export default router;
