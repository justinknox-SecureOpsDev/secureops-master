/**
 * Brand + company configuration.
 *
 * Two layers, merged at runtime:
 *
 *   1. Environment defaults — set these before deploying a new client:
 *
 *        COMPANY_NAME          Full legal company name  (e.g. "Acme Security LLC")
 *        COMPANY_SHORT_NAME    Short / acronym name     (e.g. "Acme")
 *        COMPANY_TAGLINE       One-line tagline         (e.g. "Professional Security Services")
 *        APP_NAME              Product / app name       (e.g. "SecureHub")
 *        BRAND_COLOR_NAVY      Primary dark hex         (e.g. "#0a0f1e")
 *        BRAND_COLOR_GOLD      Accent hex               (e.g. "#d4a843")
 *        BRAND_COLOR_CREAM     Background accent hex    (e.g. "#f5ead6")
 *        BILLING_EMAIL         Billing contact email    (e.g. "billing@acmesecurity.com")
 *        HR_EMAIL              HR contact email         (e.g. "hr@acmesecurity.com")
 *        ADMIN_NOTIFY_EMAIL    Ops/alerts inbox         (e.g. "ops@acmesecurity.com")
 *        DEMO_ADMIN_EMAIL      Seeded admin email       (e.g. "admin@acmesecurity.com")
 *        DEMO_ADMIN_PASSWORD   Seeded admin password    (e.g. "Change_me_2024!")
 *        DEMO_EMPLOYEE_EMAIL   Seeded employee email    (e.g. "officer@acmesecurity.com")
 *        DEMO_EMPLOYEE_PASSWORD Seeded employee password (e.g. "Change_me_2024!")
 *
 *   2. Super-admin DB overrides — the `platform_brand_config` singleton row,
 *      editable live from the admin portal (Platform → Branding). Any non-null
 *      override column wins over the env default; clearing it falls back to env.
 *
 * The exported `brand` object is MUTABLE and updated in place by
 * `applyBrandOverrides()` (called on boot via `loadBrandOverridesFromDb()` and
 * after every save). Because consumers read `brand.companyName` at call time,
 * edits flow through to emails, PDFs, and the public /api/brand endpoint with
 * no further wiring. All values fall back to WCSG defaults so the existing
 * production deployment needs no changes.
 */
import { eq } from "drizzle-orm";
import { db, platformBrandConfigTable } from "@workspace/db";

export type BrandConfig = {
  companyName: string;
  shortName: string;
  tagline: string;
  appName: string;
  colorNavy: string;
  colorGold: string;
  colorCream: string;
  billingEmail: string;
  hrEmail: string;
  adminNotifyEmail: string;
  salesEmail: string;
  privacyEmail: string;
  logoDataUrl: string | null;
  demoAdminEmail: string;
  demoAdminPassword: string;
  demoEmployeeEmail: string;
  demoEmployeePassword: string;
  demoLeadEmail: string;
  demoLeadPassword: string;
  demoGuestEmail: string;
  demoGuestPassword: string;
};

// Immutable env baseline — the fallback every override layer resets back to.
const ENV_BRAND: BrandConfig = {
  companyName:       process.env.COMPANY_NAME        ?? "Williams Council Security Group",
  shortName:         process.env.COMPANY_SHORT_NAME  ?? "WCSG",
  tagline:           process.env.COMPANY_TAGLINE      ?? "Professional Security Services",
  appName:           process.env.APP_NAME             ?? "SecureOps",
  colorNavy:         process.env.BRAND_COLOR_NAVY     ?? "#0c0a08",
  colorGold:         process.env.BRAND_COLOR_GOLD     ?? "#c9a04a",
  colorCream:        process.env.BRAND_COLOR_CREAM    ?? "#f0e4c0",
  billingEmail:      process.env.BILLING_EMAIL        ?? "billing@williamscouncilsecurity.com",
  hrEmail:           process.env.HR_EMAIL             ?? "hr@williamscouncilsecurity.com",
  adminNotifyEmail:  process.env.ADMIN_NOTIFY_EMAIL   ?? "admin@williamscouncil.com",
  // Inbox that receives inbound sales / sign-up leads from the marketing site.
  // Falls back to the central admin-notify inbox when no dedicated sales address
  // is configured. Server-side only — not exposed via the public /api/brand and
  // not overridable from the UI.
  salesEmail:        process.env.SALES_EMAIL          ?? process.env.ADMIN_NOTIFY_EMAIL ?? "admin@williamscouncil.com",
  privacyEmail:      process.env.PRIVACY_EMAIL        ?? "privacy@williamscouncilsecurity.com",
  logoDataUrl:       null,
  demoAdminEmail:    process.env.DEMO_ADMIN_EMAIL     ?? "admin@secureops.com",
  demoAdminPassword: process.env.DEMO_ADMIN_PASSWORD  ?? "Admin123!",
  demoEmployeeEmail: process.env.DEMO_EMPLOYEE_EMAIL  ?? "officer@secureops.com",
  demoEmployeePassword: process.env.DEMO_EMPLOYEE_PASSWORD ?? "Employee123!",
  demoLeadEmail:     process.env.DEMO_LEAD_EMAIL      ?? "lead@secureops.com",
  demoLeadPassword:  process.env.DEMO_LEAD_PASSWORD   ?? "Lead123!",
  demoGuestEmail:    process.env.DEMO_GUEST_EMAIL     ?? "guest@secureops.com",
  demoGuestPassword: process.env.DEMO_GUEST_PASSWORD  ?? "Demo123!",
};

/**
 * Live, mutable brand config. Starts at the env baseline and is patched in
 * place by `applyBrandOverrides`. Import this anywhere — reads see the latest
 * merged values because the object identity never changes.
 */
export const brand: BrandConfig = { ...ENV_BRAND };

// Columns the super-admin may override from the UI. (salesEmail / privacyEmail
// and demo credentials stay env-only.)
const OVERRIDABLE_KEYS = [
  "companyName",
  "shortName",
  "tagline",
  "appName",
  "colorNavy",
  "colorGold",
  "colorCream",
  "billingEmail",
  "hrEmail",
  "adminNotifyEmail",
  "logoDataUrl",
] as const;

type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];

/**
 * Patch the live `brand` object from a `platform_brand_config` row. Resets
 * every overridable field back to the env baseline first, then applies any
 * non-null/non-empty override, so clearing a field in the UI correctly falls
 * back to env. String fields only; logoDataUrl may be null.
 */
export function applyBrandOverrides(
  row: Partial<Record<OverridableKey, string | null>> | null | undefined,
): void {
  for (const k of OVERRIDABLE_KEYS) {
    (brand as Record<string, unknown>)[k] = ENV_BRAND[k];
  }
  if (!row) return;
  for (const k of OVERRIDABLE_KEYS) {
    const v = row[k];
    if (v !== null && v !== undefined && v !== "") {
      (brand as Record<string, unknown>)[k] = v;
    }
  }
}

/** Synchronous read of the current merged brand config. */
export function getBrand(): BrandConfig {
  return brand;
}

/**
 * Load the super-admin brand overrides from the DB into the in-memory `brand`
 * object. Called on boot. Falls back silently to env defaults if the table
 * doesn't exist yet (pre-`db push`).
 */
export async function loadBrandOverridesFromDb(): Promise<void> {
  try {
    const [row] = await db
      .select()
      .from(platformBrandConfigTable)
      .where(eq(platformBrandConfigTable.id, "singleton"))
      .limit(1);
    applyBrandOverrides(row ?? null);
  } catch {
    // Table missing (pre-push) or transient DB error — keep env defaults.
  }
}
