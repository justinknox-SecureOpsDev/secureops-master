/**
 * Brand + company configuration.
 *
 * Source priority (highest wins):
 *   1. platform_brand_config DB singleton  (set by control-plane API)
 *   2. Environment variables               (set at deploy time)
 *   3. Built-in WCSG defaults
 *
 * Call `loadBrandFromDb()` once at server boot (after the DB is ready) to
 * apply DB overrides.  The control-plane PUT /brand handler calls
 * `applyBrandRow()` on each successful write to keep the live object current
 * without requiring a restart.
 *
 * All consumers that previously imported `{ brand }` continue to work
 * unchanged — they get a mutable object whose properties reflect the highest-
 * priority source at the time of access.
 */

import { z } from "zod/v4";
import type { PlatformBrandConfig } from "@workspace/db";

// ---------------------------------------------------------------------------
// Type + Zod schema
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Zod schema for a brand update payload (PUT /api/control-plane/brand). */
export const BrandUpdateSchema = z.object({
  companyName:          z.string().min(1).optional(),
  shortName:            z.string().min(1).optional(),
  tagline:              z.string().optional(),
  appName:              z.string().min(1).optional(),
  colorNavy:            z.string().regex(HEX_COLOR, "Must be a 6-digit hex colour (#rrggbb)").optional(),
  colorGold:            z.string().regex(HEX_COLOR, "Must be a 6-digit hex colour (#rrggbb)").optional(),
  colorCream:           z.string().regex(HEX_COLOR, "Must be a 6-digit hex colour (#rrggbb)").optional(),
  billingEmail:         z.email().optional(),
  hrEmail:              z.email().optional(),
  adminNotifyEmail:     z.email().optional(),
  privacyEmail:         z.email().optional(),
  demoAdminEmail:       z.email().optional(),
  demoAdminPassword:    z.string().min(8).optional(),
  demoEmployeeEmail:    z.email().optional(),
  demoEmployeePassword: z.string().min(8).optional(),
  demoLeadEmail:        z.email().optional(),
  demoLeadPassword:     z.string().min(8).optional(),
});

export type BrandUpdate = z.infer<typeof BrandUpdateSchema>;

export type BrandConfig = {
  companyName:          string;
  shortName:            string;
  tagline:              string;
  appName:              string;
  colorNavy:            string;
  colorGold:            string;
  colorCream:           string;
  billingEmail:         string;
  hrEmail:              string;
  adminNotifyEmail:     string;
  privacyEmail:         string;
  demoAdminEmail:       string;
  demoAdminPassword:    string;
  demoEmployeeEmail:    string;
  demoEmployeePassword: string;
  demoLeadEmail:        string;
  demoLeadPassword:     string;
};

// ---------------------------------------------------------------------------
// Env-var / built-in defaults (lowest priority, evaluated once at boot)
// ---------------------------------------------------------------------------

const ENV_DEFAULTS: BrandConfig = {
  companyName:          process.env.COMPANY_NAME           ?? "Williams Council Security Group",
  shortName:            process.env.COMPANY_SHORT_NAME     ?? "WCSG",
  tagline:              process.env.COMPANY_TAGLINE        ?? "Professional Security Services",
  appName:              process.env.APP_NAME               ?? "SecureOps",
  colorNavy:            process.env.BRAND_COLOR_NAVY       ?? "#080c18",
  colorGold:            process.env.BRAND_COLOR_GOLD       ?? "#c9a84c",
  colorCream:           process.env.BRAND_COLOR_CREAM      ?? "#f0e6c8",
  billingEmail:         process.env.BILLING_EMAIL          ?? "billing@williamscouncilsecurity.com",
  hrEmail:              process.env.HR_EMAIL               ?? "hr@williamscouncilsecurity.com",
  adminNotifyEmail:     process.env.ADMIN_NOTIFY_EMAIL     ?? "admin@williamscouncil.com",
  privacyEmail:         process.env.PRIVACY_EMAIL          ?? "privacy@williamscouncilsecurity.com",
  demoAdminEmail:       process.env.DEMO_ADMIN_EMAIL       ?? "admin@secureops.com",
  demoAdminPassword:    process.env.DEMO_ADMIN_PASSWORD    ?? "Admin123!",
  demoEmployeeEmail:    process.env.DEMO_EMPLOYEE_EMAIL    ?? "officer@secureops.com",
  demoEmployeePassword: process.env.DEMO_EMPLOYEE_PASSWORD ?? "Employee123!",
  demoLeadEmail:        process.env.DEMO_LEAD_EMAIL        ?? "lead@secureops.com",
  demoLeadPassword:     process.env.DEMO_LEAD_PASSWORD     ?? "Lead123!",
};

// ---------------------------------------------------------------------------
// Live brand object — starts from env defaults; DB row overrides applied at
// boot and on each control-plane PUT.
// ---------------------------------------------------------------------------

/** Live brand configuration.  Read-access is always safe; mutations go through applyBrandRow(). */
export let brand: BrandConfig = { ...ENV_DEFAULTS };

/**
 * Apply a DB platform_brand_config row on top of env/default values.
 * NULL columns are ignored — the env default stays in place.
 *
 * Rebuilds from ENV_DEFAULTS on every call so removing a DB value (setting
 * it to NULL) correctly falls back to the env/default, not the previous live
 * value.
 */
export function applyBrandRow(row: Partial<PlatformBrandConfig>): void {
  const next: BrandConfig = { ...ENV_DEFAULTS };
  if (row.companyName          != null) next.companyName          = row.companyName;
  if (row.shortName            != null) next.shortName            = row.shortName;
  if (row.tagline              != null) next.tagline              = row.tagline;
  if (row.appName              != null) next.appName              = row.appName;
  if (row.colorNavy            != null) next.colorNavy            = row.colorNavy;
  if (row.colorGold            != null) next.colorGold            = row.colorGold;
  if (row.colorCream           != null) next.colorCream           = row.colorCream;
  if (row.billingEmail         != null) next.billingEmail         = row.billingEmail;
  if (row.hrEmail              != null) next.hrEmail              = row.hrEmail;
  if (row.adminNotifyEmail     != null) next.adminNotifyEmail     = row.adminNotifyEmail;
  if (row.privacyEmail         != null) next.privacyEmail         = row.privacyEmail;
  if (row.demoAdminEmail       != null) next.demoAdminEmail       = row.demoAdminEmail;
  if (row.demoAdminPassword    != null) next.demoAdminPassword    = row.demoAdminPassword;
  if (row.demoEmployeeEmail    != null) next.demoEmployeeEmail    = row.demoEmployeeEmail;
  if (row.demoEmployeePassword != null) next.demoEmployeePassword = row.demoEmployeePassword;
  if (row.demoLeadEmail        != null) next.demoLeadEmail        = row.demoLeadEmail;
  if (row.demoLeadPassword     != null) next.demoLeadPassword     = row.demoLeadPassword;
  brand = next;
}

/**
 * Load the singleton brand config from the DB and apply it on top of env defaults.
 * Non-fatal: if the table doesn't exist yet (first boot before schema push) the
 * env defaults remain active and a warning is logged.
 */
export async function loadBrandFromDb(): Promise<void> {
  try {
    const { db: dbClient, platformBrandConfigTable } = await import("@workspace/db");
    const [row] = await dbClient.select().from(platformBrandConfigTable).limit(1);
    if (row) {
      applyBrandRow(row);
    }
  } catch (err) {
    const { logger } = await import("./logger");
    logger.warn({ err }, "[brand] could not load brand config from DB — using env/defaults (table may not exist yet)");
  }
}
