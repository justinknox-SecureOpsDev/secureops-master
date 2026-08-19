import { pgTable, text, boolean, timestamp, integer, date, uuid } from "drizzle-orm/pg-core";

/**
 * Super-admin-controlled platform settings.
 *
 * Currently used only for runtime feature-flag overrides. Each row stores
 * the explicit on/off state for one feature key (see
 * `artifacts/api-server/src/lib/features.ts`). A row's `enabled` value
 * overrides whatever the `DISABLED_FEATURES` env var said at boot.
 *
 * Absent row → fall back to env (default ENABLED unless listed in
 * `DISABLED_FEATURES`).
 */
export const platformFeatureOverridesTable = pgTable("platform_feature_overrides", {
  featureKey: text("feature_key").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export type PlatformFeatureOverride = typeof platformFeatureOverridesTable.$inferSelect;

/**
 * Per-customer plan configuration. Single-row (id = 'singleton').
 * Stores the commercial details for the current deployment's customer:
 * company name, active pricing tier, custom monthly price, officer
 * headcount, billing notes, and plan start date. Managed exclusively
 * by the platform super-admin via /admin/platform/customer-config.
 */
export const platformCustomerConfigTable = pgTable("platform_customer_config", {
  id: text("id").primaryKey(),
  customerName: text("customer_name"),
  planTier: text("plan_tier"), // "starter" | "professional" | "enterprise" | "custom"
  monthlyPriceCents: integer("monthly_price_cents"), // e.g. 89900 = $899.00/mo
  officerCount: integer("officer_count"),
  billingNotes: text("billing_notes"),
  planStartDate: date("plan_start_date"),
  // Processing fee — applied to auto-synced and manually generated invoices.
  // processingFeeEnabled: whether the fee is active for this deployment.
  // processingFeeRate: percentage string, e.g. "8.25" (= 8.25%).
  processingFeeEnabled: boolean("processing_fee_enabled"),
  processingFeeRate: text("processing_fee_rate"),
  // Max hours an officer may move their own clock-in/out at post-shift
  // confirmation. Numeric string (e.g. "2" or "0.5"). Null → fall back to the
  // TIME_CONFIRM_EDIT_WINDOW_HOURS env var, then a 2h default. See
  // artifacts/api-server/src/lib/confirmEditWindowConfig.ts.
  timeConfirmEditWindowHours: text("time_confirm_edit_window_hours"),
  // Default wait after a shift's scheduled end before an abandoned time entry
  // is auto-closed. A site's own auto_clock_out_delay_minutes wins; null here
  // preserves the historical 10-minute fallback. See scheduledJobs.ts.
  autoClockOutDelayMinutes: integer("auto_clock_out_delay_minutes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  updatedBy: text("updated_by"),
});

export type PlatformCustomerConfig = typeof platformCustomerConfigTable.$inferSelect;

/**
 * Per-deployment brand overrides. Single-row (id = 'singleton').
 *
 * Lets the platform super-admin customize the white-label identity (company
 * name, tagline, app name, palette, contact emails, logo) live from the admin
 * UI instead of redeploying with new env vars. Any non-null column overrides
 * the corresponding `COMPANY_*` / `BRAND_*` / `*_EMAIL` env default; a null /
 * absent column falls back to the env value. Logo is stored inline as a
 * base64 data URI so it works pre-auth on both web and mobile without an
 * object-storage ACL round-trip. Managed exclusively via
 * /admin/platform/brand (requireSuperAdmin).
 */
export const platformBrandConfigTable = pgTable("platform_brand_config", {
  id: text("id").primaryKey(),
  companyName: text("company_name"),
  shortName: text("short_name"),
  tagline: text("tagline"),
  companyLicense: text("company_license"),
  appName: text("app_name"),
  colorNavy: text("color_navy"),
  colorGold: text("color_gold"),
  colorCream: text("color_cream"),
  billingEmail: text("billing_email"),
  hrEmail: text("hr_email"),
  adminNotifyEmail: text("admin_notify_email"),
  // users.id of the admin who runs pre-hire background checks. They get the
  // in-app notification + email when an approved application needs a check.
  // Unset (or a user who is no longer an admin) falls back to every admin, so
  // the request can never silently go nowhere.
  backgroundCheckAdminUserId: text("background_check_admin_user_id"),
  logoDataUrl: text("logo_data_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  updatedBy: text("updated_by"),
});

export type PlatformBrandConfig = typeof platformBrandConfigTable.$inferSelect;

/**
 * Uploaded "actual" platform agreement documents. One row per slot
 * (`msa` | `user_agreement`). When a row exists, the admin portal's
 * Legal & Agreements page serves this uploaded PDF instead of the
 * bundled template; deleting the row reverts to the template. Managed
 * exclusively by the platform super-admin via /admin/platform/agreements.
 */
export const platformAgreementDocsTable = pgTable("platform_agreement_docs", {
  slot: text("slot").primaryKey(), // "msa" | "user_agreement"
  fileKey: text("file_key").notNull(), // canonical /objects/... path
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"),
  // SHA-256 (hex) of the stored PDF bytes, computed server-side when the
  // document is registered. Nullable so rows uploaded before this column
  // existed keep working; every new/replaced upload populates it.
  documentSha256: text("document_sha256"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  uploadedBy: text("uploaded_by"),
});

export type PlatformAgreementDoc = typeof platformAgreementDocsTable.$inferSelect;

/**
 * In-app electronic signatures for the SOBBU platform agreements
 * (`msa` | `user_agreement`). Append-only: each signing inserts a new row and
 * the latest row per slot is the current signed version — earlier rows are
 * retained as an audit trail and are never updated or deleted.
 *
 * `documentMarkdown` is the FULL filled agreement text exactly as presented
 * at signing (immutable snapshot — later template edits cannot alter what
 * was signed), `documentSha256` is its hash, `fieldsJson` the fill values,
 * and `consentText` the verbatim consent language shown to the signer.
 * Guarantor columns are populated only when the optional MSA Exhibit C
 * personal guaranty was executed.
 */
export const platformAgreementSignaturesTable = pgTable("platform_agreement_signatures", {
  id: uuid("id").primaryKey().defaultRandom(),
  slot: text("slot").notNull(), // "msa" | "user_agreement"
  documentTitle: text("document_title").notNull(),
  documentMarkdown: text("document_markdown").notNull(),
  documentSha256: text("document_sha256").notNull(),
  fieldsJson: text("fields_json").notNull(),
  consentText: text("consent_text").notNull(),
  signerUserId: uuid("signer_user_id"),
  signerName: text("signer_name").notNull(),
  signerTitle: text("signer_title").notNull(),
  signerEmail: text("signer_email").notNull(),
  signatureText: text("signature_text").notNull(),
  guarantorName: text("guarantor_name"),
  guarantorTitle: text("guarantor_title"),
  guarantorAddress: text("guarantor_address"),
  guarantorSignature: text("guarantor_signature"),
  guarantyConsentText: text("guaranty_consent_text"),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});

export type PlatformAgreementSignature = typeof platformAgreementSignaturesTable.$inferSelect;
