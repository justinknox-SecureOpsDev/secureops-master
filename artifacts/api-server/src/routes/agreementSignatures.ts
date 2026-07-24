/**
 * In-app signing of the SOBBU platform agreements (MSA + User Agreement).
 *
 * The customer-org admin reviews the fillable agreement in the admin portal
 * (Legal & Agreements → Review & sign), with fields auto-populated from the
 * platform setup (customer config, brand config, org code, deployment
 * domain). Signing stores an immutable snapshot of the FULL filled markdown,
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
import { renderLegalPdf } from "@workspace/legal-docs/pdf";
import { requireAdmin } from "../middlewares/auth";
import { brand } from "../lib/brandConfig";
import { businessTimeZone } from "../lib/businessTime";

const router: Router = Router();

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

/**
 * Auto-populate fill values from the platform setup. Only allow-listed
 * field keys are ever produced — commercial notes like `billingNotes` are
 * deliberately never surfaced here.
 */
async function buildPrefill(slot: AgreementSlot): Promise<Record<string, string>> {
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
    values["customerLegalName"] = config?.customerName?.trim() || brand.companyName;
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
    values["billingContact"] = brand.billingEmail;
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
  // Static defaults for anything still blank.
  for (const def of AGREEMENT_FIELDS[slot]) {
    if (!values[def.key] && def.defaultValue) values[def.key] = def.defaultValue;
  }
  return values;
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
    const prefill = await buildPrefill(slot);
    const signed = await latestSignature(slot);
    slots[slot] = {
      title: AGREEMENT_TITLES[slot],
      template: LEGAL_TEMPLATES[slot],
      consentText: AGREEMENT_CONSENT_TEXTS[slot],
      guarantyConsentText: slot === "msa" ? GUARANTY_CONSENT_TEXT : null,
      fields: AGREEMENT_FIELDS[slot].map((def) => ({
        key: def.key,
        label: def.label,
        group: def.group,
        required: def.required,
        hint: def.hint ?? null,
        multiline: def.multiline ?? false,
        value: prefill[def.key] ?? "",
      })),
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

const signBody = z.object({
  fields: z.record(z.string(), z.string().max(500)),
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

  // Merge only allow-listed field keys (plus defaults) — unknown keys and
  // anything not in the field definitions are dropped.
  const values: Record<string, string> = {};
  for (const def of AGREEMENT_FIELDS[slot]) {
    const raw = body.fields[def.key]?.trim() || def.defaultValue || "";
    if (raw) values[def.key] = raw;
  }
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

/** Stream the signed PDF (filled snapshot + signature certificate). */
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

  const doc = renderLegalPdf({
    title: row.documentTitle,
    markdown: row.documentMarkdown,
    signature: {
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
        slot !== "msa"
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
    },
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${AGREEMENT_FILE_BASES[slot]}-signed.pdf"`,
  );
  doc.pipe(res);
});

export default router;
