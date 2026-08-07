/**
 * Shared zod schemas for the super-admin platform surface.
 *
 * These are the single source of truth for validating brand overrides and
 * feature-flag updates. They are imported by BOTH:
 *   - routes/platform.ts        (the in-app super-admin UI, JWT-gated)
 *   - routes/controlPlane.ts    (the remote HMAC-authed control-plane surface)
 *
 * Keeping them here means the remote control plane can never write a brand /
 * feature payload the in-app UI would reject — the validation is identical on
 * both paths.
 */

import { z } from "zod/v4";
import { FEATURE_KEYS } from "./features";

// ── Feature-flag updates ────────────────────────────────────────────────────

export const featureUpdateBody = z.object({
  updates: z.array(
    z.object({
      key: z.enum(FEATURE_KEYS as unknown as [string, ...string[]]),
      // null = clear the override and fall back to env baseline
      enabled: z.boolean().nullable(),
    }),
  ),
});

// ── Brand overrides ─────────────────────────────────────────────────────────

// "" → null so blank inputs clear an override rather than failing validation.
const blankToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? null : v), schema);

const hexColor = blankToNull(
  z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex colour").nullable(),
);
const emailField = blankToNull(z.string().email().max(200).nullable());

export const brandConfigSchema = z.object({
  companyName: blankToNull(z.string().max(200).nullable()),
  shortName: blankToNull(z.string().max(60).nullable()),
  tagline: blankToNull(z.string().max(200).nullable()),
  // .optional() so brand PUTs from not-yet-redeployed clients (older control
  // plane / cached portal bundles) that omit the key still validate; an absent
  // key means "leave unchanged" on update rather than a 400.
  companyLicense: blankToNull(z.string().max(120).nullable().optional()),
  appName: blankToNull(z.string().max(80).nullable()),
  colorNavy: hexColor,
  colorGold: hexColor,
  colorCream: hexColor,
  billingEmail: emailField,
  hrEmail: emailField,
  adminNotifyEmail: emailField,
  // users.id of the designated background-check admin. .optional() so brand
  // PUTs from clients that predate this field leave it unchanged instead of
  // 400ing (see companyLicense above).
  backgroundCheckAdminUserId: blankToNull(z.string().uuid().max(64).nullable().optional()),
  // Inline base64 data URI (capped ~512 KB encoded). Must be an image.
  logoDataUrl: blankToNull(
    z
      .string()
      .max(700_000)
      .refine((s) => s.startsWith("data:image/"), "Must be an image data URI")
      .nullable(),
  ),
});

export type BrandConfigInput = z.infer<typeof brandConfigSchema>;

// ── Customer / commercial config ────────────────────────────────────────────

/**
 * Customer / commercial config, validated identically on BOTH:
 *   - routes/platform.ts     (the in-app super-admin UI, JWT-gated)
 *   - routes/controlPlane.ts (the remote HMAC-authed control-plane surface)
 *
 * Every field is `.nullable().optional()`: `null` explicitly CLEARS a value,
 * while an ABSENT key means "leave the stored value unchanged". The control
 * plane is a separately-versioned deployment, so a save from an older control
 * plane (or a stale cached portal bundle) that omits a field it doesn't know
 * about must never 400 or clobber that field — hence omission-tolerance here.
 */
export const customerConfigSchema = z.object({
  customerName: z.string().max(200).nullable().optional(),
  planTier: z.enum(["starter", "professional", "enterprise", "custom"]).nullable().optional(),
  monthlyPriceCents: z.number().int().min(0).nullable().optional(),
  officerCount: z.number().int().min(1).nullable().optional(),
  billingNotes: z.string().max(2000).nullable().optional(),
  planStartDate: z.string().nullable().optional(),
  processingFeeEnabled: z.boolean().nullable().optional(),
  processingFeeRate: z
    .string()
    .max(20)
    .regex(/^\d{1,3}(\.\d{1,4})?$/, "processingFeeRate must be a numeric percentage")
    .refine((v) => {
      const n = parseFloat(v);
      return n > 0 && n <= 100;
    }, "processingFeeRate must be between 0 (exclusive) and 100")
    .nullable()
    .optional(),
  // Officer post-shift self-edit window, in hours. Numeric string; positive.
  // "" / null → clear the override (fall back to env / 2h default).
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

export type CustomerConfigInput = z.infer<typeof customerConfigSchema>;

/**
 * The customer-config keys that map 1:1 to `platform_customer_config` columns,
 * in a stable order.
 */
export const CUSTOMER_CONFIG_WRITE_KEYS = [
  "customerName",
  "planTier",
  "monthlyPriceCents",
  "officerCount",
  "billingNotes",
  "planStartDate",
  "processingFeeEnabled",
  "processingFeeRate",
  "timeConfirmEditWindowHours",
] as const;

/**
 * Reduce a parsed customer-config payload to the columns to actually write:
 * ONLY keys that are present (not `undefined`). An absent key is intentionally
 * skipped so it is left unchanged on update rather than nulled out.
 */
export function pickCustomerConfigColumns(data: CustomerConfigInput): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  for (const key of CUSTOMER_CONFIG_WRITE_KEYS) {
    const v = (data as Record<string, unknown>)[key];
    if (v !== undefined) cols[key] = v;
  }
  return cols;
}
