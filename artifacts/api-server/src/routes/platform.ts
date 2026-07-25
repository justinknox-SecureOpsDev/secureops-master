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
import { eq, sql } from "drizzle-orm";
import { db, platformFeatureOverridesTable, platformCustomerConfigTable, platformBrandConfigTable, platformAgreementDocsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  AGREEMENT_SLOTS,
  type AgreementSlot,
  parseAgreementSlot,
  agreementUploadBody,
  agreementRowToDto,
  registerAgreementDoc,
} from "../lib/agreementDocs";
import { brand, applyBrandOverrides } from "../lib/brandConfig";
import { applyProcessingFeeConfig } from "../lib/processingFeeConfig";
import { applyConfirmEditWindowConfig } from "../lib/confirmEditWindowConfig";
import {
  type FeatureKey,
  getFeatureFlagDetails,
  loadFeatureOverridesFromDb,
  setOverrideInMemory,
  clearOverrideInMemory,
} from "../lib/features";
import {
  featureUpdateBody,
  brandConfigSchema,
  customerConfigSchema,
  pickCustomerConfigColumns,
} from "../lib/platformSchemas";
import { buildCustomerConfigChanges, buildBrandChanges, buildFeatureChanges } from "../lib/settingsAudit";

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

  // Snapshot the effective enabled state per key BEFORE applying so we can
  // record a clear old→new paper trail for each toggled flag.
  const beforeEnabled = new Map(getFeatureFlagDetails().map((f) => [f.key as string, f.enabled]));

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
  const afterDetails = getFeatureFlagDetails();
  const afterEnabled = new Map(afterDetails.map((f) => [f.key as string, f.enabled]));
  const auditMeta = buildFeatureChanges(
    parsed.data.updates.map((u) => ({
      key: u.key,
      old: beforeEnabled.get(u.key) ?? false,
      new: afterEnabled.get(u.key) ?? false,
    })),
  );
  if (auditMeta) res.locals["auditMetadata"] = auditMeta;
  res.json({ features: afterDetails });
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

/** Upserts the customer plan / commercial config for this deployment. */
router.put("/admin/platform/customer-config", requireAuth, requireSuperAdmin, async (req, res) => {
  const parsed = customerConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = req.user?.email ?? "unknown";

  // Snapshot the FULL config BEFORE the upsert so we can record a clear old→new
  // paper trail for every changed field. The generic auditLogMiddleware records
  // this PUT as `admin.action`; stashing the changes on res.locals.auditMetadata
  // gives reviewers the specific before/after values (who changed plan, pricing,
  // processing fees, the officer self-edit window, and when).
  const [priorConfig] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);

  // Write ONLY the keys the client actually sent — an absent key is left
  // unchanged (every field in customerConfigSchema is .optional()), so a
  // version-skewed client never clobbers a field it doesn't know about.
  const cols = pickCustomerConfigColumns(parsed.data);
  const insertValues = {
    id: "singleton",
    updatedBy: editor,
    ...cols,
  } as typeof platformCustomerConfigTable.$inferInsert;

  await db
    .insert(platformCustomerConfigTable)
    .values(insertValues)
    .onConflictDoUpdate({
      target: platformCustomerConfigTable.id,
      set: { ...cols, updatedBy: editor, updatedAt: sql`now()` },
    });

  const [config] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
  applyProcessingFeeConfig(config ?? null);
  applyConfirmEditWindowConfig(config ?? null);

  // Record the old→new values for every changed field in the audit log. Only
  // the keys the client actually sent are compared (read back from the stored
  // row), so an older client that omits a key never triggers a spurious
  // "changed" entry. Values are plain scalars — no redaction required.
  const afterConfig: Record<string, unknown> = {};
  for (const key of Object.keys(cols)) {
    afterConfig[key] = (config as Record<string, unknown> | undefined)?.[key] ?? null;
  }
  const auditMeta = buildCustomerConfigChanges(
    (priorConfig ?? {}) as Record<string, unknown>,
    afterConfig,
  );
  if (auditMeta) res.locals["auditMetadata"] = auditMeta;

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

  // Snapshot the prior brand row so we can record a clear old→new paper trail
  // for every changed field in the audit log.
  const [priorConfig] = await db
    .select()
    .from(platformBrandConfigTable)
    .where(eq(platformBrandConfigTable.id, "singleton"))
    .limit(1);

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

  // Record the old→new values for every changed brand field. The logo blob is
  // never persisted — the helper records only a set/unset flag for it.
  const auditMeta = buildBrandChanges(
    (priorConfig ?? {}) as Record<string, unknown>,
    d as Record<string, unknown>,
  );
  if (auditMeta) res.locals["auditMetadata"] = auditMeta;

  res.json({ config });
});

// ---- Platform agreement documents (Legal & Agreements page) ----------------
//
// Each "slot" is one of the bundled platform agreements (MSA, User Agreement).
// A super-admin can upload the *actual* signed/finalized PDF for a slot; the
// portal then serves that document instead of the bundled template. Deleting
// the slot's row reverts to the template. Regular admins can read status and
// download the uploaded document; only the super-admin can change it.

const storage = new ObjectStorageService();

/** Per-slot status: has an actual document been uploaded, or is the template in effect? */
router.get("/admin/platform/agreements", requireAdmin, async (_req, res) => {
  const rows = await db.select().from(platformAgreementDocsTable);
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  res.json({ agreements: AGREEMENT_SLOTS.map((slot) => agreementRowToDto(slot, bySlot.get(slot))) });
});

/** Short-lived signed URL for viewing/downloading the uploaded document of a slot. */
router.get("/admin/platform/agreements/:slot/url", requireAdmin, async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) { res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" }); return; }
  const [row] = await db.select().from(platformAgreementDocsTable).where(eq(platformAgreementDocsTable.slot, slot)).limit(1);
  if (!row) { res.status(404).json({ error: "Not Found", message: "No uploaded document for this agreement" }); return; }
  try {
    const url = await storage.getSignedDownloadURL(row.fileKey);
    res.json({ url, fileName: row.fileName });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not Found", message: "The uploaded document is missing from storage" });
      return;
    }
    throw err;
  }
});

/**
 * Register an uploaded PDF (via the standard presigned-upload flow) as the
 * actual document for a slot. The server re-downloads the object to verify it
 * exists, is a real PDF (magic bytes), and is within the size cap, and records
 * its SHA-256 — the client-declared metadata on the presigned PUT is not
 * trusted. Shared with the remote control-plane route so both paths validate
 * and store identically.
 */
router.put("/admin/platform/agreements/:slot", requireAuth, requireSuperAdmin, async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) { res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" }); return; }
  const parsed = agreementUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }

  const editor = req.user?.email ?? "unknown";
  const result = await registerAgreementDoc(storage, {
    slot,
    fileKey: parsed.data.fileKey,
    fileName: parsed.data.fileName,
    editor,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: "Bad request", message: result.message });
    return;
  }
  res.json(result.dto);
});

/** Revert a slot to the bundled template (removes the uploaded-document record). */
router.delete("/admin/platform/agreements/:slot", requireAuth, requireSuperAdmin, async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) { res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" }); return; }
  await db.delete(platformAgreementDocsTable).where(eq(platformAgreementDocsTable.slot, slot));
  res.json(agreementRowToDto(slot, undefined));
});

export default router;
