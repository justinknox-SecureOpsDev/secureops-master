/**
 * Tenant backend config preflight.
 *
 * Run this ON a customer/tenant backend deployment — from that project's own
 * Shell, after working through `docs/new-customer-setup-runbook.md` — to
 * confirm every piece of required production config is actually present
 * before telling the customer their system is ready. Reads `process.env`
 * directly (this process's own environment), so run it in the same
 * environment (dev Shell or a Deployment's console) whose config you want to
 * verify.
 *
 * Prints every gap at once, grouped by area, instead of the current runtime
 * behavior of surfacing a missing setting only when a user hits the feature
 * it powers (a silently-skipped invite email, a stale WCSG company name in a
 * PDF, etc) — and only checks one thing (SMTP) at server boot today.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-tenant-config
 *
 * Exit code 0 — every REQUIRED check passed (RECOMMENDED gaps only warn).
 * Exit code 1 — at least one REQUIRED check failed.
 */

type Severity = "required" | "recommended";

interface CheckResult {
  area: string;
  name: string;
  severity: Severity;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function record(area: string, name: string, severity: Severity, ok: boolean, detail?: string): void {
  results.push({ area, name, severity, ok, detail });
}

function has(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function val(name: string): string {
  return (process.env[name] ?? "").trim();
}

// ---- Core: database, sessions ----
record("Core", "DATABASE_URL is set", "required", has("DATABASE_URL"));

{
  const secret = val("SESSION_SECRET");
  // Known non-production placeholders that must never reach a real deploy —
  // see check-security-headers.ts and app-server's own smoke-test env for
  // where the test fallback comes from.
  const PLACEHOLDER_SECRETS = new Set([
    "dev-session-secret-change-me",
    "test-session-secret-at-least-32-chars-long",
  ]);
  record("Core", "SESSION_SECRET is set", "required", secret.length > 0);
  if (secret.length > 0) {
    record(
      "Core",
      "SESSION_SECRET is not a known placeholder value",
      "required",
      !PLACEHOLDER_SECRETS.has(secret),
    );
    record(
      "Core",
      "SESSION_SECRET is reasonably long (>= 32 chars)",
      "recommended",
      secret.length >= 32,
      `currently ${secret.length} chars`,
    );
  }
}

// ---- Org identity & allowed origins ----
{
  const orgCode = val("ORG_CODE");
  record("Org identity", "ORG_CODE is set", "required", orgCode.length > 0);
  if (orgCode.length > 0) {
    record(
      "Org identity",
      "ORG_CODE looks like a valid slug (lowercase letters/digits/hyphens)",
      "required",
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(orgCode),
      `currently "${orgCode}"`,
    );
  }
}
record(
  "Org identity",
  "APP_BASE_URL or REPLIT_DOMAINS is set (needed to build links in emails)",
  "required",
  has("APP_BASE_URL") || has("REPLIT_DOMAINS"),
);
record(
  "Org identity",
  "ALLOWED_ORIGINS or REPLIT_DOMAINS is set (needed for browser CORS)",
  "required",
  has("ALLOWED_ORIGINS") || has("REPLIT_DOMAINS"),
);

// ---- Object storage ----
record("Object storage", "PRIVATE_OBJECT_DIR is set", "required", has("PRIVATE_OBJECT_DIR"));
record("Object storage", "PUBLIC_OBJECT_SEARCH_PATHS is set", "required", has("PUBLIC_OBJECT_SEARCH_PATHS"));

// ---- Email ----
{
  const resendReady = has("RESEND_API_KEY") && (has("RESEND_FROM") || has("SMTP_FROM"));
  const smtpReady =
    has("SMTP_HOST") && has("SMTP_PORT") && has("SMTP_USER") && has("SMTP_PASS") && (has("SMTP_FROM") || has("RESEND_FROM"));
  record(
    "Email",
    "A working email provider is configured (Resend or SMTP)",
    "required",
    resendReady || smtpReady,
    resendReady || smtpReady
      ? undefined
      : "neither RESEND_API_KEY+RESEND_FROM nor full SMTP_HOST/PORT/USER/PASS+FROM is set — invites, password resets, and onboarding emails will not send",
  );

  const provider = val("EMAIL_PROVIDER").toLowerCase();
  if (provider) {
    record(
      "Email",
      "EMAIL_PROVIDER is a recognized value (resend | smtp)",
      "recommended",
      provider === "resend" || provider === "smtp",
      `currently "${provider}"`,
    );
    if (provider === "resend") {
      record("Email", "EMAIL_PROVIDER=resend has Resend fully configured", "required", resendReady);
    }
    if (provider === "smtp") {
      record("Email", "EMAIL_PROVIDER=smtp has SMTP fully configured", "required", smtpReady);
    }
  }
}

// ---- SMS (Twilio) ----
{
  const twilioVars = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"];
  const missing = twilioVars.filter((v) => !has(v));
  const configured = missing.length === 0;
  const partial = missing.length > 0 && missing.length < twilioVars.length;
  record(
    "SMS",
    "Twilio is fully configured (emergency + shift-notice SMS will send)",
    "recommended",
    configured,
    configured ? undefined : partial ? `partially set — missing ${missing.join(", ")}` : "not configured — SMS alerts are disabled; push notifications still work",
  );
}

// ---- Control plane (fleet management) ----
record(
  "Control plane",
  "CONTROL_PLANE_SHARED_SECRET is set (required for fleet registration + remote brand/feature management)",
  "required",
  has("CONTROL_PLANE_SHARED_SECRET"),
);

// ---- Brand identity ----
// These env vars are only the boot-time FALLBACK layer (see lib/brandConfig.ts)
// — a correctly onboarded customer more commonly sets their real brand via
// Platform -> Branding in the admin portal, which lives in the database and
// this script (reading only process.env) cannot see. So an env-var gap here
// does NOT necessarily mean the tenant is unbranded; it means "double-check
// Platform -> Branding shows the customer's name, not WCSG's, before
// handover." Kept as RECOMMENDED rather than REQUIRED for that reason, and
// also because WCSG's own canonical deployment correctly matches these
// defaults and would otherwise always "fail" this check.
const WCSG_DEFAULTS: Record<string, string> = {
  COMPANY_NAME: "Williams Council Security Group",
  COMPANY_SHORT_NAME: "WCSG",
  APP_NAME: "SecureOps",
  BILLING_EMAIL: "pay@williamscouncil.com",
  HR_EMAIL: "hr@williamscouncilsecurity.com",
  ADMIN_NOTIFY_EMAIL: "admin@williamscouncil.com",
};
for (const [name, wcsgDefault] of Object.entries(WCSG_DEFAULTS)) {
  const v = val(name);
  const isDefault = v === wcsgDefault;
  record(
    "Brand",
    `${name} env default is customized for this tenant`,
    "recommended",
    v.length > 0 && !isDefault,
    v.length === 0
      ? "not set — falls back to the WCSG template default (fine if branded via Platform -> Branding instead)"
      : isDefault
        ? `still the WCSG template default ("${wcsgDefault}") — is this intentional?`
        : undefined,
  );
}

// ---- Report ----
function statusTag(ok: boolean, severity: Severity): string {
  if (ok) return "OK  ";
  return severity === "required" ? "FAIL" : "WARN";
}

let area = "";
for (const r of results) {
  if (r.area !== area) {
    area = r.area;
    console.log(`\n${area}`);
  }
  const tag = statusTag(r.ok, r.severity);
  console.log(`  [${tag}] ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}

const failedRequired = results.filter((r) => !r.ok && r.severity === "required");
const failedRecommended = results.filter((r) => !r.ok && r.severity === "recommended");
const passed = results.length - failedRequired.length - failedRecommended.length;

console.log(
  `\n${passed}/${results.length} checks passed` +
    (failedRecommended.length ? `, ${failedRecommended.length} recommended gap(s)` : "") +
    (failedRequired.length ? `, ${failedRequired.length} REQUIRED gap(s)` : "") +
    ".",
);

if (failedRequired.length > 0) {
  console.log("\nThis backend is NOT ready for production traffic — fix the FAIL items above.");
  process.exit(1);
} else if (failedRecommended.length > 0) {
  console.log("\nAll required config is present. Review the WARN items above before handover.");
} else {
  console.log("\nAll required and recommended config is present.");
}
