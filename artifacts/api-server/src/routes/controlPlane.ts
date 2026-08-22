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
import { and, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  platformFeatureOverridesTable,
  platformBrandConfigTable,
  platformCustomerConfigTable,
  platformAgreementSignaturesTable,
  platformAgreementDocsTable,
  clientsTable,
  clientAgreementsTable,
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
import { applyConfirmEditWindowConfig } from "../lib/confirmEditWindowConfig";
import { requireControlPlaneHmac } from "../lib/controlPlaneAuth";
import { BUILD_VERSION, BUILD_TIME } from "../lib/buildInfo";

const router: Router = Router();
const storage = new ObjectStorageService();

// Every route under /control-plane requires a valid HMAC signature.
router.use("/control-plane", requireControlPlaneHmac);

// ---------------------------------------------------------------------------
// Control Plane customer profile and agreement drafts
// ---------------------------------------------------------------------------

const customerProfileBodySchema = z.object({
  clientId: z.string().uuid().optional(),
  legalName: z.string().min(1),
  primaryContactName: z.string().min(1).optional(),
  primaryContactEmail: z.email().optional(),
  primaryContactPhone: z.string().optional(),
  billingAddress: z.string().optional(),
  serviceAddress: z.string().optional(),
});

const createAgreementBodySchema = z.object({
  templateKey: z.string().min(1),
  templateVersion: z.string().optional(),
  title: z.string().min(1),
  renderedContent: z.string().trim().min(1).max(50_000),
  mergeSnapshot: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

function safeClientProfile(client: typeof clientsTable.$inferSelect) {
  return {
    id: client.id,
    externalCustomerId: client.externalCustomerId,
    name: client.name,
    legalName: client.legalName,
    primaryContactName: client.primaryContactName,
    primaryContactEmail: client.primaryContactEmail,
    primaryContactPhone: client.primaryContactPhone,
    contactName: client.contactName,
    contactEmail: client.contactEmail,
    contactPhone: client.contactPhone,
    billingAddress: client.billingAddress,
    serviceAddress: client.serviceAddress,
    paymentTermsDays: client.paymentTermsDays,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

function safeAgreement(agreement: typeof clientAgreementsTable.$inferSelect) {
  return {
    id: agreement.id,
    clientId: agreement.clientId,
    templateKey: agreement.templateKey,
    templateVersion: agreement.templateVersion,
    version: agreement.version,
    title: agreement.title,
    status: agreement.status,
    renderedContent: agreement.renderedContent,
    contentHash: agreement.contentHash,
    mergeSnapshot: agreement.mergeSnapshot,
    expiresAt: agreement.expiresAt,
    sentAt: agreement.sentAt,
    sentBy: agreement.sentBy,
    signedAt: agreement.signedAt,
    signedByEmail: agreement.signedByEmail,
    signedByName: agreement.signedByName,
    typedSignerName: agreement.typedSignerName,
    signatureVersionSeen: agreement.signatureVersionSeen,
    signatureHashSeen: agreement.signatureHashSeen,
    viewedAt: agreement.viewedAt,
    declinedAt: agreement.declinedAt,
    declineReason: agreement.declineReason,
    supersededAt: agreement.supersededAt,
    supersededByAgreementId: agreement.supersededByAgreementId,
    expiredAt: agreement.expiredAt,
    hasDocument: Boolean(agreement.documentStorageKey),
    hasCompletedDocument: Boolean(agreement.completedDocumentStorageKey),
    createdAt: agreement.createdAt,
    updatedAt: agreement.updatedAt,
  };
}

async function resolveClientByExternalId(externalCustomerId: string) {
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.externalCustomerId, externalCustomerId))
    .limit(1);
  return client ?? null;
}

router.put(
  "/control-plane/customers/:externalCustomerId/profile",
  async (req, res) => {
    const { externalCustomerId } = req.params;
    if (!externalCustomerId?.trim()) {
      res
        .status(400)
        .json({ error: "Bad Request", message: "externalCustomerId required" });
      return;
    }

    const parsed = customerProfileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Bad Request", issues: parsed.error.issues });
      return;
    }

    const {
      clientId,
      legalName,
      primaryContactName,
      primaryContactEmail,
      primaryContactPhone,
      billingAddress,
      serviceAddress,
    } = parsed.data;

    try {
      let existing: typeof clientsTable.$inferSelect | undefined;
      if (clientId) {
        [existing] = await db
          .select()
          .from(clientsTable)
          .where(eq(clientsTable.id, clientId))
          .limit(1);
        if (!existing) {
          res
            .status(404)
            .json({ error: "Not Found", message: "clientId not found" });
          return;
        }
      } else {
        [existing] = await db
          .select()
          .from(clientsTable)
          .where(eq(clientsTable.externalCustomerId, externalCustomerId))
          .limit(1);
      }

      const patch: Record<string, unknown> = {
        externalCustomerId,
        legalName,
        updatedAt: new Date(),
      };
      if (primaryContactName !== undefined) {
        patch.primaryContactName = primaryContactName;
        patch.contactName = primaryContactName;
      }
      if (primaryContactEmail !== undefined) {
        patch.primaryContactEmail = primaryContactEmail;
        patch.contactEmail = primaryContactEmail;
      }
      if (primaryContactPhone !== undefined) {
        patch.primaryContactPhone = primaryContactPhone;
        patch.contactPhone = primaryContactPhone;
      }
      if (billingAddress !== undefined) patch.billingAddress = billingAddress;
      if (serviceAddress !== undefined) patch.serviceAddress = serviceAddress;

      let client: typeof clientsTable.$inferSelect;
      if (existing) {
        [client] = await db
          .update(clientsTable)
          .set(patch)
          .where(eq(clientsTable.id, existing.id))
          .returning();
      } else {
        [client] = await db
          .insert(clientsTable)
          .values({ name: legalName, ...patch })
          .returning();
      }

      res.json({ client: safeClientProfile(client) });
    } catch (error) {
      req.log?.error(
        { err: error },
        "[control-plane/customers] profile upsert error",
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

router.get(
  "/control-plane/customers/:externalCustomerId/agreements",
  async (req, res) => {
    const client = await resolveClientByExternalId(
      req.params.externalCustomerId,
    );
    if (!client) {
      res
        .status(404)
        .json({ error: "Not Found", message: "Customer not found" });
      return;
    }

    try {
      const agreements = await db
        .select()
        .from(clientAgreementsTable)
        .where(eq(clientAgreementsTable.clientId, client.id))
        .orderBy(clientAgreementsTable.createdAt);
      res.json({ agreements: agreements.map(safeAgreement) });
    } catch (error) {
      req.log?.error(
        { err: error },
        "[control-plane/agreements] list error",
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

router.post(
  "/control-plane/customers/:externalCustomerId/agreements",
  async (req, res) => {
    const client = await resolveClientByExternalId(
      req.params.externalCustomerId,
    );
    if (!client) {
      res
        .status(404)
        .json({ error: "Not Found", message: "Customer not found" });
      return;
    }

    const parsed = createAgreementBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Bad Request", issues: parsed.error.issues });
      return;
    }

    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify(parsed.data), "utf8")
      .digest("hex");

    try {
      const [existing] = await db
        .select()
        .from(clientAgreementsTable)
        .where(
          and(
            eq(clientAgreementsTable.clientId, client.id),
            eq(
              clientAgreementsTable.requestFingerprint,
              requestFingerprint,
            ),
          ),
        )
        .limit(1);
      if (existing) {
        res.status(201).json({ agreement: safeAgreement(existing) });
        return;
      }

      const agreement = await db.transaction(async (tx) => {
        const result = await tx.execute<{ current_version: number }>(sql`
          INSERT INTO client_agreement_version_seqs
            (client_id, template_key, current_version)
          VALUES (${client.id}::uuid, ${parsed.data.templateKey}, 1)
          ON CONFLICT (client_id, template_key)
          DO UPDATE
            SET current_version =
              client_agreement_version_seqs.current_version + 1
          RETURNING current_version
        `);
        const version = result.rows[0]?.current_version ?? 1;

        const [created] = await tx
          .insert(clientAgreementsTable)
          .values({
            clientId: client.id,
            templateKey: parsed.data.templateKey,
            templateVersion: parsed.data.templateVersion ?? null,
            requestFingerprint,
            version,
            title: parsed.data.title,
            status: "draft",
            renderedContent: parsed.data.renderedContent,
            mergeSnapshot: parsed.data.mergeSnapshot ?? null,
            expiresAt: parsed.data.expiresAt
              ? new Date(parsed.data.expiresAt)
              : null,
          })
          .returning();
        return created;
      });
      res.status(201).json({ agreement: safeAgreement(agreement) });
    } catch (error) {
      // A concurrent retry may win the unique-fingerprint race. Its transaction
      // commits; this transaction (including the version increment) rolls back.
      const [existing] = await db
        .select()
        .from(clientAgreementsTable)
        .where(
          and(
            eq(clientAgreementsTable.clientId, client.id),
            eq(
              clientAgreementsTable.requestFingerprint,
              requestFingerprint,
            ),
          ),
        )
        .limit(1);
      if (existing) {
        res.status(201).json({ agreement: safeAgreement(existing) });
        return;
      }
      req.log?.error(
        { err: error },
        "[control-plane/agreements] create error",
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

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
  applyConfirmEditWindowConfig(config);
  res.json({ customerConfig: config });
});

export default router;
