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
  appName: blankToNull(z.string().max(80).nullable()),
  colorNavy: hexColor,
  colorGold: hexColor,
  colorCream: hexColor,
  billingEmail: emailField,
  hrEmail: emailField,
  adminNotifyEmail: emailField,
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
