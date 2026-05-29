/**
 * Automated accessibility regression suite for the WCSG Admin Portal.
 *
 * Drives a real Chromium browser (Playwright) over the portal's key surfaces
 * and runs axe-core against each, failing on any critical/serious WCAG 2.1
 * A/AA violation (missing labels, missing roles, color-contrast, ARIA misuse).
 *
 * Surfaces covered:
 *   - Public Apply form          /admin-portal/apply
 *   - Public Onboard form        /admin-portal/onboard/:token   (token minted here)
 *   - Public Amend form          /admin-portal/amend/:token     (token minted here)
 *   - DataGrid table page        /admin-portal/tables/employees (admin login)
 *   - Import wizard dialog        (opened on the employees table page)
 *
 * Run on demand:
 *   pnpm --filter @workspace/scripts run a11y
 *
 * Requires the dev workflows (admin-portal + api-server) to be running so the
 * shared proxy serves both. Override the proxy origin / admin credentials with
 * A11Y_BASE_URL, A11Y_ADMIN_EMAIL, A11Y_ADMIN_PASSWORD.
 *
 * Chromium is resolved from the Nix-provided system binary (PLAYWRIGHT_CHROMIUM
 * or `which chromium`) because the Playwright-bundled headless shell is missing
 * shared libraries in this environment.
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  applicationsTable,
  onboardingTokensTable,
  applicationAmendmentTokensTable,
} from "@workspace/db";

const BASE_URL = (process.env.A11Y_BASE_URL ?? "http://localhost:80").replace(/\/$/, "");
const PORTAL = `${BASE_URL}/admin-portal`;
const API = `${BASE_URL}/api`;
const ADMIN_EMAIL = process.env.A11Y_ADMIN_EMAIL ?? "admin@secureops.com";
const ADMIN_PASSWORD = process.env.A11Y_ADMIN_PASSWORD ?? "Admin123!";
const TOKEN_KEY = "wcsg.adminToken";

// WCAG 2.0 + 2.1, levels A and AA. axe groups its rules under these tags.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
// We gate the build on the two highest-severity buckets. Lower-severity
// findings (e.g. "moderate" landmark/region hints) are reported but don't fail.
const FAIL_IMPACTS = new Set(["critical", "serious"]);

type AxeNode = { target: unknown[]; failureSummary?: string };
type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
};

function resolveChromium(): string {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  try {
    return execSync("which chromium").toString().trim();
  } catch {
    throw new Error(
      "Could not find a Chromium binary. Set PLAYWRIGHT_CHROMIUM, or install it " +
        "with the package-management skill (Nix package `chromium`).",
    );
  }
}

async function adminLogin(): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Admin login failed (${res.status}). Is api-server running and seeded?`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Admin login returned no token (2FA enabled on this account?).");
  return data.token;
}

type Seeded = {
  onboardToken: string;
  amendToken: string;
  cleanup: () => Promise<void>;
};

/** Mint short-lived onboarding + amendment tokens so the token-gated public
 *  forms actually render their fields (not the "invalid link" error state). */
async function seedTokens(): Promise<Seeded> {
  // Onboarding token must reference a real user row. Prefer an employee, fall
  // back to any user so the suite still runs on a sparsely-seeded DB.
  const [employee] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, "employee"))
    .limit(1);
  const [anyUser] = employee ? [employee] : await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (!anyUser) throw new Error("No users in the database — cannot mint an onboarding token.");

  const onboardToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  const [onboardRow] = await db
    .insert(onboardingTokensTable)
    .values({ token: onboardToken, employeeId: anyUser.id, expiresAt })
    .returning({ id: onboardingTokensTable.id });

  // Amendment token needs an application in `info_requested` plus the list of
  // fields the applicant must complete. Cover text, textarea, number, date and
  // file inputs so the form (and FileUploadField) all get exercised.
  const [app] = await db
    .insert(applicationsTable)
    .values({
      status: "info_requested",
      firstName: "A11y",
      lastName: "Probe",
      email: `a11y-probe-${randomBytes(4).toString("hex")}@example.invalid`,
      phone: "+12145550000",
      address: "1 Test Plaza",
    })
    .returning({ id: applicationsTable.id });

  const amendToken = randomBytes(24).toString("base64url");
  const [amendRow] = await db
    .insert(applicationAmendmentTokensTable)
    .values({
      token: amendToken,
      applicationId: app.id,
      requestedFields: ["phone", "address", "siaLicenseLevel", "siaLicenseExpiry", "photo"],
      note: "Please complete the highlighted items so we can finish reviewing your application.",
      expiresAt,
    })
    .returning({ id: applicationAmendmentTokensTable.id });

  async function cleanup() {
    await db.delete(onboardingTokensTable).where(eq(onboardingTokensTable.id, onboardRow.id));
    await db.delete(applicationAmendmentTokensTable).where(eq(applicationAmendmentTokensTable.id, amendRow.id));
    await db.delete(applicationsTable).where(eq(applicationsTable.id, app.id));
  }

  return { onboardToken, amendToken, cleanup };
}

async function runAxe(page: Page, scopeSelector?: string): Promise<AxeViolation[]> {
  let builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  if (scopeSelector) builder = builder.include(scopeSelector);
  const { violations } = await builder.analyze();
  return violations as unknown as AxeViolation[];
}

type Surface = {
  name: string;
  /** Navigate + wait until the meaningful content has rendered. */
  open: (page: Page) => Promise<void>;
  /** Optional CSS scope to constrain the axe run (e.g. a dialog). */
  scope?: string;
};

function buildSurfaces(seeded: Seeded, adminToken: string): Surface[] {
  return [
    {
      name: "Apply form (/apply)",
      open: async (page) => {
        await page.goto(`${PORTAL}/apply`, { waitUntil: "networkidle" });
        // The multi-step form renders a step <h2> (e.g. "Personal details");
        // earlier states show an <h1>. Wait for any heading to settle.
        await page.getByRole("heading").first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Onboard form (/onboard/:token)",
      open: async (page) => {
        await page.goto(`${PORTAL}/onboard/${seeded.onboardToken}`, { waitUntil: "networkidle" });
        // Wait for the prefill to resolve into the multi-step form (or surface a
        // load error, which we treat as a setup failure below).
        await page.getByRole("button", { name: /continue|submit/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Amend form (/amend/:token)",
      open: async (page) => {
        await page.goto(`${PORTAL}/amend/${seeded.amendToken}`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: /submit/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Employees DataGrid (/tables/employees)",
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/tables/employees`, adminToken);
        // Grid toolbar exposes a Refresh control once the page is interactive.
        await page.getByRole("button", { name: /refresh/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Import wizard dialog (employees)",
      scope: '[role="dialog"]',
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/tables/employees`, adminToken);
        const importBtn = page.getByRole("button", { name: /^import$/i }).first();
        await importBtn.waitFor({ timeout: 20_000 });
        await importBtn.click();
        await page.getByRole("dialog").waitFor({ timeout: 20_000 });
      },
    },
  ];
}

/** Navigate to an admin-only route with the JWT pre-seeded into localStorage so
 *  the SPA boots straight into the authenticated view. */
async function openAuthed(page: Page, url: string, token: string): Promise<void> {
  // Pass the token as JSON-embedded literals so this runs without DOM typings.
  await page.addInitScript(
    `try { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)}); } catch (e) {}`,
  );
  await page.goto(url, { waitUntil: "networkidle" });
}

function reportViolations(surface: string, violations: AxeViolation[]): number {
  const gating = violations.filter((v) => FAIL_IMPACTS.has(v.impact ?? ""));
  const minor = violations.filter((v) => !FAIL_IMPACTS.has(v.impact ?? ""));

  if (gating.length === 0) {
    const note = minor.length ? ` (${minor.length} non-gating finding(s) ignored)` : "";
    console.log(`  ✅ ${surface}: no critical/serious violations${note}`);
    return 0;
  }

  console.log(`  ❌ ${surface}: ${gating.length} critical/serious violation(s)`);
  for (const v of gating) {
    console.log(`     • [${v.impact}] ${v.id} — ${v.help}`);
    console.log(`       ${v.helpUrl}`);
    for (const node of v.nodes.slice(0, 5)) {
      console.log(`       at ${JSON.stringify(node.target)}`);
      if (node.failureSummary) {
        console.log(`         ${node.failureSummary.replace(/\n/g, "\n         ")}`);
      }
    }
    if (v.nodes.length > 5) console.log(`       …and ${v.nodes.length - 5} more node(s)`);
  }
  return gating.length;
}

async function main() {
  console.log(`Accessibility scan against ${PORTAL}`);
  const executablePath = resolveChromium();

  const adminToken = await adminLogin();
  const seeded = await seedTokens();

  let browser: Browser | null = null;
  let totalFailures = 0;
  let setupFailures = 0;

  try {
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    const surfaces = buildSurfaces(seeded, adminToken);

    for (const surface of surfaces) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await surface.open(page);
        const violations = await runAxe(page, surface.scope);
        totalFailures += reportViolations(surface.name, violations);
      } catch (err) {
        setupFailures += 1;
        console.log(`  ⚠️  ${surface.name}: could not render for scanning — ${(err as Error).message}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await seeded.cleanup();
    await pool.end();
  }

  console.log("");
  if (setupFailures > 0) {
    console.error(`${setupFailures} surface(s) failed to load — cannot vouch for their accessibility.`);
  }
  if (totalFailures > 0) {
    console.error(`Accessibility scan FAILED: ${totalFailures} critical/serious violation(s).`);
  }
  if (totalFailures > 0 || setupFailures > 0) process.exit(1);
  console.log("Accessibility scan passed: no critical/serious violations on any surface.");
}

main().catch((err) => {
  console.error("Accessibility scan errored:", err);
  process.exit(1);
});
