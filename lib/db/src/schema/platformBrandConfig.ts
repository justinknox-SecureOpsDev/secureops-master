import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton platform brand configuration, managed via the control-plane API.
 *
 * All brand columns are nullable TEXT. The server falls back to env-var /
 * built-in defaults for any column that is NULL, so a fresh deployment with
 * no row behaves identically to the previous env-only approach.
 *
 * There is exactly one row in this table (id = 'singleton'), upserted by
 * PUT /api/control-plane/brand.
 */
export const platformBrandConfigTable = pgTable("platform_brand_config", {
  id:                   text("id").primaryKey().default("singleton"),
  companyName:          text("company_name"),
  shortName:            text("short_name"),
  tagline:              text("tagline"),
  appName:              text("app_name"),
  colorNavy:            text("color_navy"),
  colorGold:            text("color_gold"),
  colorCream:           text("color_cream"),
  billingEmail:         text("billing_email"),
  hrEmail:              text("hr_email"),
  adminNotifyEmail:     text("admin_notify_email"),
  privacyEmail:         text("privacy_email"),
  demoAdminEmail:       text("demo_admin_email"),
  demoAdminPassword:    text("demo_admin_password"),
  demoEmployeeEmail:    text("demo_employee_email"),
  demoEmployeePassword: text("demo_employee_password"),
  demoLeadEmail:        text("demo_lead_email"),
  demoLeadPassword:     text("demo_lead_password"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PlatformBrandConfig = typeof platformBrandConfigTable.$inferSelect;
