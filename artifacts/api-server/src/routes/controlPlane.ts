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
  platformCustomerConfigTable,
  platformAgreementSignaturesTable,
  platformAgreementDocsTable,
} from "@workspace/db";
import { AGREEMENT_SLOTS, AGREEMENT_TITLES } from "@workspace/legal-docs";
import { z } from "zod/v4";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  MAX_AGREEMENT_PDF_BYTES,
  parseAgreementSlot,
  agreementUploadBody,
  registerAgreementDoc,
  readAgreementDocDtos,
  agreementRowToDto,
} from "../lib/agreementDocs";
import { applyBrandOverrides } from "../lib/brandConfig";
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
import { applyProcessingFeeConfig } from "../lib/processingFeeConfig";
import { applyConfirmEditWindowConfig } from "../lib/confirmEditWindowConfig";
import { requireControlPlaneHmac } from "../lib/controlPlaneAuth";
import { BUILD_VERSION, BUILD_TIME } from "../lib/buildInfo";

const router: Router = Router();
const storage = new ObjectStorageService();

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

async function readCustomerConfigRow() {
  const [config] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
  return config ?? null;
}

/**
 * Read the current managed settings: brand override row + feature flags +
 * customer/commercial config + build identity. The control plane opens this
 * when an operator views a customer's Remote Settings, so `customerConfig`
 * prefills the "Plan & Billing" panel.
 */
router.get("/control-plane/settings", async (_req, res) => {
  const brandRow = await readBrandRow();
  const customerConfig = await readCustomerConfigRow();
  const agreementDocs = await readAgreementDocDtos();
  res.json({
    version: BUILD_VERSION,
    builtAt: BUILD_TIME,
    brand: brandRow,
    features: getFeatureFlagDetails(),
    customerConfig,
    agreementDocs,
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

/**
 * Mint a short-lived presigned upload URL so the operator's browser can push an
 * agreement PDF straight into THIS customer's object storage — the same
 * presigned-upload flow the in-app super-admin page uses. Only the URL is
 * returned here; the object is validated + registered by the PUT below. Size
 * and content-type are gated up-front (the actual bytes go straight to storage,
 * so this is the only pre-upload check); the PUT re-validates the stored bytes.
 */
router.post("/control-plane/agreements/upload-url", async (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1),
      size: z.number().min(1),
      contentType: z.string().min(1),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const { name, size, contentType } = parsed.data;
  if (size > MAX_AGREEMENT_PDF_BYTES) {
    res.status(413).json({ error: "Payload Too Large", message: "PDF exceeds the 15 MB limit" });
    return;
  }
  const isPdf =
    contentType.split(";")[0].trim().toLowerCase() === "application/pdf" ||
    /\.pdf$/i.test(name);
  if (!isPdf) {
    res.status(415).json({ error: "Unsupported Media Type", message: "File must be a PDF" });
    return;
  }
  const uploadURL = await storage.getObjectEntityUploadURL();
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  res.json({ uploadURL, objectPath });
});

/**
 * Register an uploaded PDF as the actual document for an agreement slot,
 * replacing the bundled template. Reuses the SAME validation the in-app
 * super-admin route uses (re-downloads the object, checks PDF magic bytes +
 * size, records the SHA-256) so a remote change is indistinguishable from an
 * in-app one.
 */
router.put("/control-plane/agreements/:slot", async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) {
    res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" });
    return;
  }
  const parsed = agreementUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const result = await registerAgreementDoc(storage, {
    slot,
    fileKey: parsed.data.fileKey,
    fileName: parsed.data.fileName,
    editor: "control-plane",
  });
  if (!result.ok) {
    res.status(result.status).json({ error: "Bad request", message: result.message });
    return;
  }
  res.json(result.dto);
});

/**
 * Revert an agreement slot to the bundled template by removing the uploaded
 * custom-document record. Mirrors the in-app super-admin DELETE route so a
 * remote revert is indistinguishable from an in-app one.
 */
router.delete("/control-plane/agreements/:slot", async (req, res) => {
  const slot = parseAgreementSlot(req.params["slot"]);
  if (!slot) {
    res.status(404).json({ error: "Not Found", message: "Unknown agreement slot" });
    return;
  }
  await db.delete(platformAgreementDocsTable).where(eq(platformAgreementDocsTable.slot, slot));
  res.json(agreementRowToDto(slot, undefined));
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

/**
 * Upsert the customer / commercial config remotely and apply the live hooks.
 *
 * Reuses the SAME zod schema as the in-app super-admin route so validation is
 * identical on both paths, and the SAME applyProcessingFeeConfig /
 * applyConfirmEditWindowConfig hooks so the invoice processing fee and the
 * officer time-edit window take effect immediately — no customer restart. Only
 * the keys present in the payload are written; an absent key is left unchanged,
 * so a version-skewed control plane never clobbers a field it doesn't know.
 */
router.put("/control-plane/customer-config", async (req, res) => {
  const parsed = customerConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad request", issues: parsed.error.issues });
    return;
  }
  const editor = "control-plane";
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

  const config = await readCustomerConfigRow();
  applyProcessingFeeConfig(config);
  applyConfirmEditWindowConfig(config);
  res.json({ customerConfig: config });
});

export default router;
