import { pgTable, text, boolean, timestamp, integer, date } from "drizzle-orm/pg-core";

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
  appName: text("app_name"),
  colorNavy: text("color_navy"),
  colorGold: text("color_gold"),
  colorCream: text("color_cream"),
  billingEmail: text("billing_email"),
  hrEmail: text("hr_email"),
  adminNotifyEmail: text("admin_notify_email"),
  logoDataUrl: text("logo_data_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  updatedBy: text("updated_by"),
});

export type PlatformBrandConfig = typeof platformBrandConfigTable.$inferSelect;
