/**
 * In-app signing of the SOBBU platform agreements (MSA + User Agreement).
 *
 * The customer-org admin reviews the fillable agreement in the admin portal
 * (Legal & Agreements → Review & sign), with fields auto-populated from the
 * platform setup (customer config, org code, deployment domain, operator
 * env). Signing stores an immutable snapshot of the FULL filled markdown,
 * its SHA-256, the fill values, and the verbatim consent text — so what was
 * agreed to is provable even if the bundled template changes later.
 *
 * Access: requireAdmin (chains auth). These are the customer's own
 * agreements, so ordinary admins — not just the super-admin — may sign.
 * Rows are append-only; the latest row per slot is the current signature.
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  platformAgreementSignaturesTable,
  platformCustomerConfigTable,
  type PlatformAgreementSignature,
} from "@workspace/db";
import {
  AGREEMENT_SLOTS,
  AGREEMENT_TITLES,
  AGREEMENT_FILE_BASES,
  AGREEMENT_FIELDS,
  AGREEMENT_CONSENT_TEXTS,
  GUARANTY_CONSENT_TEXT,
  LEGAL_TEMPLATES,
  fillAgreement,
  type AgreementSlot,
} from "@workspace/legal-docs";
import { renderLegalPdf, pdfToBuffer, type SignatureCertificate } from "@workspace/legal-docs/pdf";
import { PDFDocument as PdfLibDocument } from "pdf-lib";
import { requireAdmin } from "../middlewares/auth";
import { businessTimeZone } from "../lib/businessTime";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  MAX_AGREEMENT_PDF_BYTES,
  readActiveAgreementDocument,
  type ActiveAgreementDocument,
} from "../lib/agreementDocs";

const router: Router = Router();

const storage = new ObjectStorageService();

function parseSlot(raw: string): AgreementSlot | null {
  return (AGREEMENT_SLOTS as readonly string[]).includes(raw) ? (raw as AgreementSlot) : null;
}

const TIER_LABELS: Record<string, string> = {
  starter: "Starter",
  professional: "Professional",
  enterprise: "Enterprise",
  custom: "Custom",
};

function deploymentDomain(): string {
  const base = process.env["APP_BASE_URL"]?.trim();
  if (base) return base.replace(/\/+$/, "");
  const replit = process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
  return replit ? `https://${replit}` : "";
}

/** The fields SOBBU sets — everything except the customer-completed ones. */
function providerDefs(slot: AgreementSlot) {
  return AGREEMENT_FIELDS[slot].filter((def) => def.authority === "provider");
}

/**
 * Resolve the SOBBU-set values for a slot from platform configuration:
 * customer config (control-plane-owned columns), org code, deployment domain,
 * operator env values, then static defaults.
 *
 * This is the ONLY source of pricing, commercial terms, agreement terms and
 * SOBBU's own entity details. The signing customer never supplies them — the
 * sign route ignores any field values in the request body. Commercial notes
 * like `billingNotes` are deliberately never surfaced here.
 *
 * NOTHING here may read tenant-editable configuration (brand config in
 * particular): a customer-org super-admin can edit their own branding, so any
 * agreement value sourced from it would be a value they set on the contract
 * they then sign.
 */
async function buildProviderValues(slot: AgreementSlot): Promise<Record<string, string>> {
  const [config] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);

  const today = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: businessTimeZone(),
  }).format(new Date());

  const values: Record<string, string> = {};
  if (slot === "msa") {
    // No fallback to brand.companyName: branding is tenant-editable, so a
    // customer could otherwise set the legal name on their own contract.
    values["customerLegalName"] = config?.customerName?.trim() ?? "";
    values["effectiveDate"] = today;
    values["orgCode"] = process.env["ORG_CODE"]?.trim() ?? "";
    values["customerDomain"] = deploymentDomain();
    values["planTier"] = config?.planTier ? (TIER_LABELS[config.planTier] ?? config.planTier) : "";
    values["feeAmount"] =
      config?.monthlyPriceCents != null
        ? `$${(config.monthlyPriceCents / 100).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`
        : "";
    // Operator-set, NOT brand.billingEmail — that one is tenant-editable, and
    // the billing contact is a commercial term of the signed agreement.
    values["billingContact"] = process.env["AGREEMENT_BILLING_CONTACT"]?.trim() ?? "";
    values["venueCounty"] = process.env["SOBBU_VENUE_COUNTY"]?.trim() ?? "";
    values["noticeEmail"] = process.env["SOBBU_NOTICE_EMAIL"]?.trim() ?? "";
    values["providerAddress"] = process.env["SOBBU_PRINCIPAL_ADDRESS"]?.trim() ?? "";
  } else {
    values["effectiveDate"] = today;
    values["arbitrationCity"] = process.env["SOBBU_ARBITRATION_CITY"]?.trim() ?? "";
    values["venueCounty"] = process.env["SOBBU_VENUE_COUNTY"]?.trim() ?? "";
    values["contactEmail"] =
      process.env["SOBBU_CONTACT_EMAIL"]?.trim() ||
      (process.env["SOBBU_NOTICE_EMAIL"]?.trim() ?? "");
    values["providerAddress"] = process.env["SOBBU_PRINCIPAL_ADDRESS"]?.trim() ?? "";
  }
  // Static defaults for anything still blank — provider fields only, so a
  // customer-completed field can never be pre-supplied from here.
  for (const def of providerDefs(slot)) {
    if (!values[def.key] && def.defaultValue) values[def.key] = def.defaultValue;
  }
  return values;
}

/**
 * Required SOBBU-set values that are still blank. Signing is blocked until
 * SOBBU fills them, because the customer has no way to supply them.
 */
function missingProviderDefs(slot: AgreementSlot, values: Record<string, string>) {
  return providerDefs(slot).filter((def) => def.required && !(values[def.key] ?? "").trim());
}

/**
 * Digest of the exact SOBBU-set values shown to the signer. The signing form
 * echoes it back, so terms that changed between page load and signature — or
 * that were never displayed — are rejected instead of silently signed.
 */
function termsDigest(slot: AgreementSlot, values: Record<string, string>): string {
  const canonical = JSON.stringify({
    slot,
    source: "template",
    values: providerDefs(slot).map((def) => [def.key, values[def.key] ?? ""]),
    // The document text is itself a term: covering the template and consent
    // wording means a stale portal bundle can't sign a version of the
    // agreement it never displayed — it gets "terms changed, reload" instead.
    template: LEGAL_TEMPLATES[slot],
    consent: AGREEMENT_CONSENT_TEXTS[slot],
    guarantyConsent: slot === "msa" ? GUARANTY_CONSENT_TEXT : null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Digest for a slot governed by an uploaded PDF. The document hash IS the
 * term here, so replacing the uploaded document between page load and
 * signature is rejected the same way changed template terms are.
 */
function uploadedTermsDigest(
  slot: AgreementSlot,
  doc: Extract<ActiveAgreementDocument, { source: "uploaded" }>,
): string {
  const canonical = JSON.stringify({
    slot,
    source: "uploaded",
    documentSha256: doc.documentSha256,
    fileName: doc.fileName,
    consent: AGREEMENT_CONSENT_TEXTS[slot],
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function toDto(row: PlatformAgreementSignature) {
  return {
    id: row.id,
    slot: row.slot,
    signerName: row.signerName,
    signerTitle: row.signerTitle,
    signerEmail: row.signerEmail,
    signedAt: row.signedAt,
    documentSha256: row.documentSha256,
    // Which document this signature was taken against, so the Legal &
    // Agreements page can say so — and warn when the slot's active document
    // has since been replaced or reverted.
    documentSource: row.documentSource,
    documentFileName: row.documentFileName,
    guarantyExecuted: Boolean(row.guarantorName),
    guarantorName: row.guarantorName,
  };
}

async function latestSignature(slot: AgreementSlot): Promise<PlatformAgreementSignature | null> {
  const [row] = await db
    .select()
    .from(platformAgreementSignaturesTable)
    .where(eq(platformAgreementSignaturesTable.slot, slot))
    .orderBy(desc(platformAgreementSignaturesTable.signedAt), desc(platformAgreementSignaturesTable.id))
    .limit(1);
  return row ?? null;
}

/**
 * Everything the signing UI needs for both agreements: template markdown,
 * field definitions with auto-populated values, consent texts, and the
 * current signature (if any) per slot.
 */
router.get("/admin/platform/agreements/signing-context", requireAdmin, async (_req, res) => {
  const slots: Record<string, unknown> = {};
  for (const slot of AGREEMENT_SLOTS) {
    const active = await readActiveAgreementDocument(storage, slot);
    const signed = await latestSignature(slot);

    if (active.source !== "template") {
      // An uploaded PDF is the whole agreement: its wording is fixed, so there
      // are no fillable terms, no provider values to resolve and no bundled
      // Exhibit C guaranty to offer. The signer reviews the PDF itself.
      slots[slot] = {
        title: AGREEMENT_TITLES[slot],
        source: "uploaded",
        template: null,
        document:
          active.source === "uploaded"
            ? {
                fileName: active.fileName,
                fileSize: active.fileSize,
                documentSha256: active.documentSha256,
                uploadedAt: active.uploadedAt ? active.uploadedAt.toISOString() : null,
              }
            : null,
        unavailableReason: active.source === "unavailable" ? active.message : null,
        consentText: AGREEMENT_CONSENT_TEXTS[slot],
        guarantyConsentText: null,
        fields: [],
        termsDigest: active.source === "uploaded" ? uploadedTermsDigest(slot, active) : "",
        readyToSign: active.source === "uploaded",
        missingProviderLabels: [],
        signed: signed ? toDto(signed) : null,
      };
      continue;
    }

    const providerValues = await buildProviderValues(slot);
    const missingProvider = missingProviderDefs(slot, providerValues);
    slots[slot] = {
      title: AGREEMENT_TITLES[slot],
      source: "template",
      document: null,
      unavailableReason: null,
      template: LEGAL_TEMPLATES[slot],
      consentText: AGREEMENT_CONSENT_TEXTS[slot],
      guarantyConsentText: slot === "msa" ? GUARANTY_CONSENT_TEXT : null,
      fields: AGREEMENT_FIELDS[slot].map((def) => ({
        key: def.key,
        label: def.label,
        group: def.group,
        required: def.required,
        authority: def.authority,
        hint: def.hint ?? null,
        multiline: def.multiline ?? false,
        // Only SOBBU's values are prefilled; customer-completed fields start blank.
        value: def.authority === "provider" ? (providerValues[def.key] ?? "") : "",
      })),
      // Ties a signature to the exact terms rendered on this page.
      termsDigest: termsDigest(slot, providerValues),
      readyToSign: missingProvider.length === 0,
      missingProviderLabels: missingProvider.map((def) => def.label),
      signed: signed ? toDto(signed) : null,
    };
  }
  res.json({ slots });
});

/** Lightweight signature status for the Legal & Agreements page. */
router.get("/admin/platform/agreements/signatures", requireAdmin, async (_req, res) => {
  const out: Record<string, unknown> = {};
  for (const slot of AGREEMENT_SLOTS) {
    const signed = await latestSignature(slot);
    out[slot] = signed ? toDto(signed) : null;
  }
  res.json({ signatures: out });
});

const guarantorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  signature: z.string().trim().min(1).max(200),
  consent: z.literal(true),
});

/**
 * The acceptance payload. It deliberately carries NO agreement field values:
 * the terms are provider-set and resolved server-side. `termsDigest` is the
 * digest handed out by the signing context, tying this signature to the exact
 * terms the signer reviewed.
 */
const signBody = z.object({
  termsDigest: z.string().trim().min(1).max(64),
  signerName: z.string().trim().min(1).max(200),
  signerTitle: z.string().trim().min(1).max(200),
  signature: z.string().trim().min(1).max(200),
  consent: z.literal(true),
  guarantor: guarantorSchema.optional(),
});

router.post("/admin/platform/agreements/:slot/sign", requireAdmin, async (req, res) => {
  const slot = parseSlot(String(req.params.slot));
  if (!slot) {
    res.status(404).json({ message: "Unknown agreement" });
    return;
  }
  const parsed = signBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid signing payload", issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  if (body.guarantor && slot !== "msa") {
    res.status(400).json({ message: "A personal guaranty applies only to the Master Subscription Agreement" });
    return;
  }

  // The uploaded PDF, when there is one, is the document being signed.
  const active = await readActiveAgreementDocument(storage, slot);
  if (active.source === "unavailable") {
    res.status(409).json({ message: active.message, code: "document_unavailable" });
    return;
  }
  if (active.source === "uploaded") {
    if (body.guarantor) {
      res.status(400).json({
        message:
          "The Exhibit C personal guaranty belongs to the bundled template. This agreement has an uploaded document, which governs on its own terms.",
      });
      return;
    }
    if (body.termsDigest !== uploadedTermsDigest(slot, active)) {
      res.status(409).json({
        message:
          "The document for this agreement changed since you opened it. Reload the page and review the current document before signing.",
        code: "terms_changed",
      });
      return;
    }

    const [uploadedRow] = await db
      .insert(platformAgreementSignaturesTable)
      .values({
        slot,
        documentTitle: AGREEMENT_TITLES[slot],
        documentSource: "uploaded",
        documentMarkdown: null,
        // Pin the exact stored object: replacing the slot's document later
        // writes a NEW object, so this signature keeps resolving to the
        // version that was actually displayed and signed.
        documentFileKey: active.fileKey,
        documentFileName: active.fileName,
        documentSha256: active.documentSha256,
        fieldsJson: "{}",
        consentText: AGREEMENT_CONSENT_TEXTS[slot],
        signerUserId: req.user?.userId ?? null,
        signerName: body.signerName,
        signerTitle: body.signerTitle,
        signerEmail: req.user?.email ?? "",
        signatureText: body.signature,
        ipAddress: req.ip ?? null,
        userAgent: req.get("user-agent")?.slice(0, 400) ?? null,
      })
      .returning();

    req.log.info(
      { slot, signatureId: uploadedRow.id, source: "uploaded" },
      "platform agreement signed",
    );
    res.status(201).json({ signature: toDto(uploadedRow) });
    return;
  }

  // Terms come from platform configuration, never from the signer. A stale or
  // tampering client can still post field values; they are dropped here, and
  // logged so the attempt is visible.
  if (req.body && typeof req.body === "object" && "fields" in (req.body as object)) {
    req.log.warn(
      { slot },
      "ignored client-supplied agreement field values — terms are provider-set",
    );
  }

  const providerValues = await buildProviderValues(slot);
  const missingProvider = missingProviderDefs(slot, providerValues);
  if (missingProvider.length > 0) {
    req.log.error(
      { slot, missing: missingProvider.map((def) => def.key) },
      "agreement cannot be signed — SOBBU terms are unset",
    );
    res.status(409).json({
      message: `This agreement is not ready to sign yet — SOBBU still has to set: ${missingProvider
        .map((def) => def.label)
        .join(", ")}. Please contact SOBBU.`,
      missingProviderLabels: missingProvider.map((def) => def.label),
    });
    return;
  }
  if (body.termsDigest !== termsDigest(slot, providerValues)) {
    res.status(409).json({
      message:
        "The terms of this agreement changed since you opened it. Reload the page and review the updated agreement before signing.",
      code: "terms_changed",
    });
    return;
  }

  const values: Record<string, string> = { ...providerValues };
  if (body.guarantor) {
    values["guarantorName"] = body.guarantor.name;
    values["guarantorTitle"] = body.guarantor.title;
    values["guarantorAddress"] = body.guarantor.address;
  }

  const filled = fillAgreement(slot, values);
  if (filled.missing.length > 0) {
    res.status(400).json({
      message: `Missing required fields: ${filled.missing.map((d) => d.label).join(", ")}`,
      missingKeys: filled.missing.map((d) => d.key),
    });
    return;
  }
  if (filled.leftoverTokens.length > 0) {
    req.log.error({ slot, leftover: filled.leftoverTokens }, "agreement fill left tokens behind");
    res.status(400).json({ message: "Agreement could not be completed — please contact support" });
    return;
  }

  const documentSha256 = createHash("sha256").update(filled.markdown, "utf8").digest("hex");
  const guarantyExecuted = slot === "msa" && Boolean(body.guarantor);

  const [row] = await db
    .insert(platformAgreementSignaturesTable)
    .values({
      slot,
      documentTitle: AGREEMENT_TITLES[slot],
      documentSource: "template",
      documentMarkdown: filled.markdown,
      documentSha256,
      fieldsJson: JSON.stringify(values),
      consentText: AGREEMENT_CONSENT_TEXTS[slot],
      signerUserId: req.user?.userId ?? null,
      signerName: body.signerName,
      signerTitle: body.signerTitle,
      signerEmail: req.user?.email ?? "",
      signatureText: body.signature,
      guarantorName: guarantyExecuted ? body.guarantor!.name : null,
      guarantorTitle: guarantyExecuted ? body.guarantor!.title : null,
      guarantorAddress: guarantyExecuted ? body.guarantor!.address : null,
      guarantorSignature: guarantyExecuted ? body.guarantor!.signature : null,
      guarantyConsentText: guarantyExecuted ? GUARANTY_CONSENT_TEXT : null,
      ipAddress: req.ip ?? null,
      userAgent: req.get("user-agent")?.slice(0, 400) ?? null,
    })
    .returning();

  req.log.info({ slot, signatureId: row.id }, "platform agreement signed");
  res.status(201).json({ signature: toDto(row) });
});

/**
 * Stream the slot's ACTIVE uploaded document for review.
 *
 * Same-origin and authenticated on purpose: the review page has to embed the
 * PDF, and the production CSP allows the portal to fetch only its own origin —
 * a signed object-storage URL would be blocked in the browser. The bytes are
 * hash-verified here, so what the signer reads is what a signature will pin.
 */
router.get("/admin/platform/agreements/:slot/document", requireAdmin, async (req, res) => {
  const slot = parseSlot(String(req.params.slot));
  if (!slot) {
    res.status(404).json({ message: "Unknown agreement" });
    return;
  }
  const active = await readActiveAgreementDocument(storage, slot);
  if (active.source === "unavailable") {
    res.status(409).json({ message: active.message, code: "document_unavailable" });
    return;
  }
  if (active.source === "template") {
    res.status(404).json({ message: "This agreement uses the bundled template" });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${AGREEMENT_FILE_BASES[slot]}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(active.buffer);
});

/**
 * Stream the signed PDF: the exact document that was displayed, with the
 * electronic-signature certificate appended.
 *
 * For a template signature that is the filled markdown snapshot. For an
 * uploaded document it is the stored PDF ITSELF — re-fetched by the file key
 * pinned on the signature row, so a document replaced or reverted since then
 * doesn't change what a past signature resolves to — with the certificate
 * appended as extra pages.
 */
router.get("/admin/platform/agreements/:slot/signed-pdf", requireAdmin, async (req, res) => {
  const slot = parseSlot(String(req.params.slot));
  if (!slot) {
    res.status(404).json({ message: "Unknown agreement" });
    return;
  }
  const row = await latestSignature(slot);
  if (!row) {
    res.status(404).json({ message: "This agreement has not been signed yet" });
    return;
  }

  const certificate: SignatureCertificate = {
    documentTitle: row.documentTitle,
    documentSha256: row.documentSha256,
    consentText: row.consentText,
    signerName: row.signerName,
    signerTitle: row.signerTitle,
    signerEmail: row.signerEmail,
    signatureText: row.signatureText,
    signedAtIso: row.signedAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: null,
    guaranty:
      slot !== "msa" || row.documentSource === "uploaded"
        ? undefined
        : row.guarantorName
          ? {
              name: row.guarantorName,
              title: row.guarantorTitle ?? "",
              address: row.guarantorAddress ?? "",
              signatureText: row.guarantorSignature ?? "",
              consentText: row.guarantyConsentText ?? GUARANTY_CONSENT_TEXT,
            }
          : "not_executed",
  };

  const fileName = `${AGREEMENT_FILE_BASES[slot]}-signed.pdf`;

  if (row.documentSource === "uploaded") {
    if (!row.documentFileKey) {
      res.status(500).json({ message: "This signature has no archived document on file" });
      return;
    }
    let uploaded: Buffer;
    try {
      const dl = await storage.downloadObjectBuffer(row.documentFileKey, {
        maxBytes: MAX_AGREEMENT_PDF_BYTES,
      });
      uploaded = dl.buffer;
    } catch {
      res.status(404).json({
        message:
          "The document this signature was taken against is no longer in storage, so the signed copy can't be assembled.",
      });
      return;
    }
    // The signature is bound to these exact bytes; refuse to hand out a
    // "signed copy" of anything else.
    const sha = createHash("sha256").update(uploaded).digest("hex");
    if (sha !== row.documentSha256) {
      req.log.error({ slot, signatureId: row.id }, "archived agreement document hash mismatch");
      res.status(409).json({
        message:
          "The archived document no longer matches the signature's recorded hash, so the signed copy can't be produced.",
      });
      return;
    }

    const certBuffer = await pdfToBuffer(
      renderLegalPdf({
        title: row.documentTitle,
        markdown: [
          `# ${row.documentTitle}`,
          "",
          `The agreement signed is the document supplied by SOBBU LLC and reproduced on the preceding pages (${row.documentFileName ?? "uploaded document"}). This page records the electronic signature taken against it.`,
        ].join("\n"),
        signature: certificate,
      }),
    );

    let merged: Uint8Array;
    try {
      const out = await PdfLibDocument.load(uploaded);
      const cert = await PdfLibDocument.load(certBuffer);
      const pages = await out.copyPages(cert, cert.getPageIndices());
      for (const page of pages) out.addPage(page);
      merged = await out.save();
    } catch (err) {
      req.log.error({ slot, err }, "could not append the signature certificate to the document");
      res.status(409).json({
        message:
          "The uploaded document could not be combined with the signature certificate (it may be encrypted). Upload an unprotected PDF and re-sign.",
      });
      return;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.end(Buffer.from(merged));
    return;
  }

  if (!row.documentMarkdown) {
    res.status(500).json({ message: "This signature has no archived document on file" });
    return;
  }

  const doc = renderLegalPdf({
    title: row.documentTitle,
    markdown: row.documentMarkdown,
    signature: certificate,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  doc.pipe(res);
});

export default router;
