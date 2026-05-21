/**
 * Brand + company configuration, driven entirely by environment variables.
 *
 * For a new client deployment, set these env vars before deploying:
 *
 *   COMPANY_NAME          Full legal company name  (e.g. "Acme Security LLC")
 *   COMPANY_SHORT_NAME    Short / acronym name     (e.g. "Acme")
 *   COMPANY_TAGLINE       One-line tagline         (e.g. "Professional Security Services")
 *   APP_NAME              Product / app name       (e.g. "SecureHub")
 *   BRAND_COLOR_NAVY      Primary dark hex         (e.g. "#0a0f1e")
 *   BRAND_COLOR_GOLD      Accent hex               (e.g. "#d4a843")
 *   BRAND_COLOR_CREAM     Background accent hex    (e.g. "#f5ead6")
 *   BILLING_EMAIL         Billing contact email    (e.g. "billing@acmesecurity.com")
 *   HR_EMAIL              HR contact email         (e.g. "hr@acmesecurity.com")
 *   DEMO_ADMIN_EMAIL      Seeded admin email       (e.g. "admin@acmesecurity.com")
 *   DEMO_ADMIN_PASSWORD   Seeded admin password    (e.g. "Change_me_2024!")
 *   DEMO_EMPLOYEE_EMAIL   Seeded employee email    (e.g. "officer@acmesecurity.com")
 *   DEMO_EMPLOYEE_PASSWORD Seeded employee password (e.g. "Change_me_2024!")
 *
 * All values fall back to WCSG defaults so the existing production deployment
 * needs no changes.
 */

export const brand = {
  companyName:       process.env.COMPANY_NAME        ?? "Williams Council Security Group",
  shortName:         process.env.COMPANY_SHORT_NAME  ?? "WCSG",
  tagline:           process.env.COMPANY_TAGLINE      ?? "Professional Security Services",
  appName:           process.env.APP_NAME             ?? "SecureOps",
  colorNavy:         process.env.BRAND_COLOR_NAVY     ?? "#080c18",
  colorGold:         process.env.BRAND_COLOR_GOLD     ?? "#c9a84c",
  colorCream:        process.env.BRAND_COLOR_CREAM    ?? "#f0e6c8",
  billingEmail:      process.env.BILLING_EMAIL        ?? "billing@williamscouncilsecurity.com",
  hrEmail:           process.env.HR_EMAIL             ?? "hr@williamscouncilsecurity.com",
  privacyEmail:      process.env.PRIVACY_EMAIL        ?? "privacy@williamscouncilsecurity.com",
  demoAdminEmail:    process.env.DEMO_ADMIN_EMAIL     ?? "admin@secureops.com",
  demoAdminPassword: process.env.DEMO_ADMIN_PASSWORD  ?? "Admin123!",
  demoEmployeeEmail: process.env.DEMO_EMPLOYEE_EMAIL  ?? "officer@secureops.com",
  demoEmployeePassword: process.env.DEMO_EMPLOYEE_PASSWORD ?? "Employee123!",
} as const;
