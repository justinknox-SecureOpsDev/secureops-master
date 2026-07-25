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
import { db, platformFeatureOverridesTable, platformCustomerConfigTable, platformBrandConfigTable, platformAgreementDocsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
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
import { featureUpdateBody, brandConfigSchema } from "../lib/platformSchemas";
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

const customerConfigSchema = z.object({
  customerName: z.string().max(200).nullable(),
  planTier: z.enum(["starter", "professional", "enterprise", "custom"]).nullable(),
  monthlyPriceCents: z.number().int().min(0).nullable(),
  officerCount: z.number().int().min(1).nullable(),
  billingNotes: z.string().max(2000).nullable(),
  planStartDate: z.string().nullable(),
  processingFeeEnabled: z.boolean().nullable(),
  processingFeeRate: z
    .string()
    .max(20)
    .regex(/^\d{1,3}(\.\d{1,4})?$/, "processingFeeRate must be a numeric percentage")
    .refine((v) => {
      const n = parseFloat(v);
      return n > 0 && n <= 100;
    }, "processingFeeRate must be between 0 (exclusive) and 100")
    .nullable(),
  // Officer post-shift self-edit window, in hours. Numeric string; positive.
  // "" / null → clear the override (fall back to env / 2h default). .optional()
  // so not-yet-redeployed clients that omit the key still validate.
  timeConfirmEditWindowHours: z
    .preprocess(
      (v) => (v === "" ? null : v),
      z
        .string()
        .max(20)
        .regex(/^\d{1,3}(\.\d{1,4})?$/, "timeConfirmEditWindowHours must be a positive number of hours")
        .refine((v) => parseFloat(v) > 0, "timeConfirmEditWindowHours must be greater than 0")
        .nullable(),
    )
    .optional(),
});

/** Upserts the customer plan / commercial config for this deployment. */
router.put("/admin/platform/customer-config", requireAuth, requireSuperAdmin, async (req, res) => {
  const parsed = customerConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = req.user?.email ?? "unknown";
  const { customerName, planTier, monthlyPriceCents, officerCount, billingNotes, planStartDate, processingFeeEnabled, processingFeeRate } = parsed.data;
  // Absent key (older client) → leave the stored value unchanged.
  const timeConfirmEditWindowHours = parsed.data.timeConfirmEditWindowHours;

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

  const insertValues = { id: "singleton", customerName, planTier, monthlyPriceCents, officerCount, billingNotes, planStartDate, processingFeeEnabled, processingFeeRate, updatedBy: editor };
  const updateValues: Record<string, unknown> = { customerName, planTier, monthlyPriceCents, officerCount, billingNotes, planStartDate, processingFeeEnabled, processingFeeRate, updatedBy: editor, updatedAt: sql`now()` };
  if (timeConfirmEditWindowHours !== undefined) {
    (insertValues as Record<string, unknown>).timeConfirmEditWindowHours = timeConfirmEditWindowHours;
    updateValues.timeConfirmEditWindowHours = timeConfirmEditWindowHours;
  }

  await db
    .insert(platformCustomerConfigTable)
    .values(insertValues)
    .onConflictDoUpdate({
      target: platformCustomerConfigTable.id,
      set: updateValues,
    });

  const [config] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
  applyProcessingFeeConfig(config ?? null);
  applyConfirmEditWindowConfig(config ?? null);

  // Record the old→new values for every changed field in the audit log. The
  // values are plain scalars (no sensitive data), so no redaction is required;
  // the middleware persists this into audit_logs.metadata. Only fields present
  // in the parsed payload are compared, so an older client that omits a key
  // never triggers a spurious "changed" entry.
  const afterConfig: Record<string, unknown> = {
    customerName, planTier, monthlyPriceCents, officerCount, billingNotes,
    planStartDate, processingFeeEnabled, processingFeeRate,
  };
  if (timeConfirmEditWindowHours !== undefined) {
    afterConfig["timeConfirmEditWindowHours"] = config?.timeConfirmEditWindowHours ?? null;
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

const AGREEMENT_SLOTS = ["msa", "user_agreement"] as const;
type AgreementSlot = (typeof AGREEMENT_SLOTS)[number];
const MAX_AGREEMENT_PDF_BYTES = 15 * 1024 * 1024; // 15 MB

function parseAgreementSlot(raw: string | string[] | undefined): AgreementSlot | null {
  if (typeof raw !== "string") return null;
  return AGREEMENT_SLOTS.includes(raw as AgreementSlot) ? (raw as AgreementSlot) : null;
}

type AgreementSlotDto = {
  slot: AgreementSlot;
  custom: {
    fileName: string;
    fileSize: number | null;
    uploadedAt: string | null;
    uploadedBy: string | null;
  } | null;
};

function agreementRowToDto(slot: AgreementSlot, row: typeof platformAgreementDocsTable.$inferSelect | undefined): AgreementSlotDto {
  return {
    slot,
    custom: row
      ? {
          fileName: row.fileName,
          fileSize: row.fileSize,
          uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
          uploadedBy: row.uploadedBy,
        }
      : null,
  };
}

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

const agreementUploadBody = z.object({
  fileKey: z.string().min(1),
  fileName: z.string().min(1).max(300),
});

/**
 * Register an uploaded PDF (via the standard presigned-upload flow) as the
 * actual document for a slot. The server re-downloads the object to verify it
 * exists, is a real PDF (magic bytes), and is within the size cap — the
 * client-declared metadata on the presigned PUT is not trusted.
 */
router.put("/admin/platform/agreements/:slot", requireAuth, requireSuperAdmin, async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) { res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" }); return; }
  const parsed = agreementUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }

  const normalized = storage.normalizeObjectEntityPath(parsed.data.fileKey);
  let size: number;
  let head: Buffer;
  try {
    const dl = await storage.downloadObjectBuffer(normalized, { maxBytes: MAX_AGREEMENT_PDF_BYTES });
    size = dl.size;
    head = dl.buffer.subarray(0, 5);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "Bad request", message: "Uploaded file not found in storage" });
      return;
    }
    if ((err as { __tooLarge?: boolean }).__tooLarge) {
      res.status(400).json({ error: "Bad request", message: "PDF exceeds the 15 MB limit" });
      return;
    }
    throw err;
  }
  if (head.toString("latin1") !== "%PDF-") {
    res.status(400).json({ error: "Bad request", message: "File is not a PDF" });
    return;
  }

  const editor = req.user?.email ?? "unknown";
  await db
    .insert(platformAgreementDocsTable)
    .values({ slot, fileKey: normalized, fileName: parsed.data.fileName, fileSize: size, uploadedBy: editor })
    .onConflictDoUpdate({
      target: platformAgreementDocsTable.slot,
      set: { fileKey: normalized, fileName: parsed.data.fileName, fileSize: size, uploadedBy: editor, uploadedAt: sql`now()` },
    });

  const [row] = await db.select().from(platformAgreementDocsTable).where(eq(platformAgreementDocsTable.slot, slot)).limit(1);
  res.json(agreementRowToDto(slot, row));
});

/** Revert a slot to the bundled template (removes the uploaded-document record). */
router.delete("/admin/platform/agreements/:slot", requireAuth, requireSuperAdmin, async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) { res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" }); return; }
  await db.delete(platformAgreementDocsTable).where(eq(platformAgreementDocsTable.slot, slot));
  res.json(agreementRowToDto(slot, undefined));
});

export default router;
