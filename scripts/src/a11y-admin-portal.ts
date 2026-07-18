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
 *   - Pay Run page               /admin-portal/payroll/pay-run  (admin login)
 *   - Applications HR page       /admin-portal/hr/applications  (admin login)
 *   - Onboarding HR page         /admin-portal/hr/onboarding    (admin login)
 *   - Audit Log page             /admin-portal/audit-log        (admin login)
 *   - Site detail page           /admin-portal/sites/:id        (admin login, site seeded here)
 *
 * Run on demand:
 *   pnpm --filter @workspace/scripts run a11y
 *
 * Self-bootstrapping: the scan needs the admin-portal + api-server served behind
 * the shared proxy, plus a seeded admin account. Rather than require a human to
 * start those workflows by hand first, this script brings up whatever is missing
 * itself (spawning the same `dev` commands the workflows use), waits for them to
 * be reachable, and ensures the documented admin account exists before scanning.
 * Anything it started, it tears down on exit. If a prerequisite genuinely can't
 * be brought up, it fails with a clear "prerequisite not ready" message that is
 * distinct from a real accessibility violation, so a cold-environment run never
 * produces a confusing false negative.
 *
 * Override the proxy origin / admin credentials with A11Y_BASE_URL,
 * A11Y_ADMIN_EMAIL, A11Y_ADMIN_PASSWORD. When custom admin credentials are
 * supplied they are used as-is (the account is assumed to already exist); the
 * auto-seed only runs for the default documented admin.
 *
 * Chromium is resolved from the Nix-provided system binary (PLAYWRIGHT_CHROMIUM
 * or `which chromium`) because the Playwright-bundled headless shell is missing
 * shared libraries in this environment.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  employeesTable,
  applicationsTable,
  onboardingTokensTable,
  applicationAmendmentTokensTable,
  clientsTable,
  sitesTable,
} from "@workspace/db";

const BASE_URL = (process.env.A11Y_BASE_URL ?? "http://localhost:80").replace(/\/$/, "");
const PORTAL = `${BASE_URL}/admin-portal`;
const API = `${BASE_URL}/api`;
const ADMIN_EMAIL =
  process.env.A11Y_ADMIN_EMAIL ?? process.env.DEMO_ADMIN_EMAIL ?? "admin@secureops.com";
const ADMIN_PASSWORD =
  process.env.A11Y_ADMIN_PASSWORD ?? process.env.DEMO_ADMIN_PASSWORD ?? "Admin123!";
// Only auto-provision the admin when the caller is relying on the default
// documented credentials. If they passed their own — or set DEMO_ADMIN_* (the
// real seeded master admin this deployment boots with) — we must not clobber
// that account's password; we assume it already exists (via seedDemoUsers) and
// is usable.
const USING_DEFAULT_ADMIN =
  !process.env.A11Y_ADMIN_EMAIL &&
  !process.env.A11Y_ADMIN_PASSWORD &&
  !process.env.DEMO_ADMIN_EMAIL &&
  !process.env.DEMO_ADMIN_PASSWORD;
const TOKEN_KEY = "wcsg.adminToken";

// Workspace root, resolved from this file (scripts/src/<file> -> ../../..).
const WORKSPACE_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
// How long to wait for a freshly-spawned service to answer behind the proxy.
const STARTUP_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The prerequisite services the scan needs behind the shared proxy. `localPort`
 * + `env` mirror each artifact's `.replit-artifact/artifact.toml` so a service
 * we spawn lands on exactly the port the proxy routes to. `healthUrl` is hit
 * through the proxy (not the raw port) so "reachable" means the same thing the
 * browser will experience.
 */
type ServiceSpec = {
  name: string;
  packageFilter: string;
  healthUrl: string;
  env: Record<string, string>;
};

const SERVICES: ServiceSpec[] = [
  {
    name: "api-server",
    packageFilter: "@workspace/api-server",
    healthUrl: `${API}/healthz`,
    env: { PORT: "8080", NODE_ENV: "development" },
  },
  {
    name: "admin-portal",
    packageFilter: "@workspace/admin-portal",
    healthUrl: `${BASE_URL}/admin-portal/`,
    env: { PORT: "25580", BASE_PATH: "/admin-portal/" },
  },
];

type ServiceHandle = { spec: ServiceSpec; child: ChildProcess; tail: () => string };

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

/** A prerequisite (service / account) couldn't be brought up. Thrown so the
 *  top-level handler can phrase the exit clearly as an environment problem,
 *  never as an accessibility violation. */
class PrerequisiteError extends Error {}

const indent = (s: string) => s.split("\n").map((l) => `      ${l}`).join("\n");

/** True when the URL answers behind the proxy with a real application response.
 *  A network error or a proxy 5xx (502/503/504 = upstream not up yet) is
 *  treated as "not reachable". */
async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Spawn a service's `dev` command as a detached process group so we can later
 *  kill the whole tree (pnpm -> node -> …). Keeps a rolling tail of its output
 *  for diagnostics if it never comes up. */
function spawnService(spec: ServiceSpec): ServiceHandle {
  const child = spawn("pnpm", ["--filter", spec.packageFilter, "run", "dev"], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const lines: string[] = [];
  const capture = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 40) lines.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("error", (e) => lines.push(`spawn error: ${e.message}`));
  return { spec, child, tail: () => lines.join("\n") || "(no output captured)" };
}

async function waitForService(spec: ServiceSpec, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(spec.healthUrl)) return;
    await sleep(2000);
  }
  throw new PrerequisiteError(
    `${spec.name} did not become reachable at ${spec.healthUrl} within ${Math.round(timeoutMs / 1000)}s`,
  );
}

/** Make sure both prerequisite services answer behind the proxy. Anything
 *  already running is reused; anything missing is started here and returned so
 *  the caller can tear it down afterwards. Every service is then waited on —
 *  including pre-existing ones — so a service that happens to be mid-restart
 *  (e.g. the dev workflows all bouncing at once) is given time to settle rather
 *  than producing a confusing transient failure. */
async function ensureServices(): Promise<ServiceHandle[]> {
  const spawned: ServiceHandle[] = [];
  for (const spec of SERVICES) {
    if (await isReachable(spec.healthUrl)) {
      console.log(`  • ${spec.name}: already running`);
      continue;
    }
    console.log(`  • ${spec.name}: not running — starting "${spec.packageFilter} run dev"…`);
    spawned.push(spawnService(spec));
  }
  for (const spec of SERVICES) {
    const handle = spawned.find((h) => h.spec === spec);
    try {
      await waitForService(spec, STARTUP_TIMEOUT_MS);
      console.log(`  ✓ ${spec.name}: ready`);
    } catch (err) {
      if (handle) {
        console.error(`\n  ⚠️  ${spec.name} failed to start. Last output:\n${indent(handle.tail())}\n`);
      }
      throw err;
    }
  }
  return spawned;
}

/** Stop every service we spawned: SIGTERM the process group, then SIGKILL any
 *  stragglers so no detached dev server outlives the scan. */
async function stopServices(handles: ServiceHandle[]): Promise<void> {
  if (handles.length === 0) return;
  const killGroup = (handle: ServiceHandle, signal: NodeJS.Signals) => {
    if (handle.child.pid == null) return;
    try {
      process.kill(-handle.child.pid, signal);
    } catch {
      /* already gone */
    }
  };
  for (const handle of handles) killGroup(handle, "SIGTERM");
  await sleep(3000);
  for (const handle of handles) killGroup(handle, "SIGKILL");
}

/**
 * Guarantee the documented admin can log in, so the scan never fails just
 * because the DB wasn't seeded (e.g. SEED_DEMO_USERS=false, or the api-server
 * we reused had seeding disabled). No-op when the caller supplied their own
 * credentials — we won't touch a real account.
 */
async function ensureSeededAdmin(): Promise<void> {
  if (!USING_DEFAULT_ADMIN) {
    console.log(`  • admin account: using caller-supplied credentials as-is`);
    return;
  }
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, ADMIN_EMAIL))
    .limit(1);

  if (!existing) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const [created] = await db
      .insert(usersTable)
      .values({
        email: ADMIN_EMAIL,
        passwordHash,
        firstName: "Admin",
        lastName: "User",
        role: "admin",
        status: "active",
        mustChangePassword: false,
        mustCompleteProfile: false,
      })
      .returning();
    if (created) await db.insert(employeesTable).values({ userId: created.id });
    console.log(`  ✓ admin account: seeded ${ADMIN_EMAIL}`);
    return;
  }

  // Exists already — make sure it can actually authenticate (active + password
  // matches the documented value). Leaves a healthy account untouched.
  const passwordOk = await bcrypt.compare(ADMIN_PASSWORD, existing.passwordHash);
  if (!passwordOk || existing.status !== "active" || existing.mustChangePassword) {
    const passwordHash = passwordOk ? existing.passwordHash : await bcrypt.hash(ADMIN_PASSWORD, 10);
    await db
      .update(usersTable)
      .set({ passwordHash, status: "active", mustChangePassword: false })
      .where(eq(usersTable.id, existing.id));
    if (!passwordOk) {
      console.warn(
        `  ⚠ admin account: reset ${ADMIN_EMAIL} password to the documented default ` +
          `(demo/dev parity; only runs in default-credential mode — supply A11Y_ADMIN_EMAIL/PASSWORD to use a custom account untouched)`,
      );
    } else {
      console.log(`  ✓ admin account: reactivated ${ADMIN_EMAIL} (password left unchanged)`);
    }
  } else {
    console.log(`  • admin account: ${ADMIN_EMAIL} already usable`);
  }
}

async function adminLogin(): Promise<string> {
  // Retry briefly on transient connectivity blips (proxy 5xx / network errors)
  // so a service flapping mid-restart doesn't masquerade as a credential
  // failure. A genuine 401 fails fast.
  const deadline = Date.now() + 30_000;
  for (;;) {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
    } catch (err) {
      if (Date.now() < deadline) {
        await sleep(2000);
        continue;
      }
      throw new PrerequisiteError(`Admin login could not reach the api-server: ${(err as Error).message}`);
    }

    if ((res.status === 502 || res.status === 503 || res.status === 504) && Date.now() < deadline) {
      await sleep(2000);
      continue;
    }

    if (!res.ok) {
      const reason =
        res.status === 401
          ? USING_DEFAULT_ADMIN
            ? "the seeded admin account couldn't authenticate"
            : "check the A11Y_ADMIN_EMAIL / A11Y_ADMIN_PASSWORD you supplied"
          : "the api-server returned an unexpected status";
      throw new PrerequisiteError(`Admin login failed (${res.status}) for ${ADMIN_EMAIL} — ${reason}.`);
    }

    const data = (await res.json()) as { token?: string; needsTotp?: boolean };
    if (data.needsTotp) {
      throw new PrerequisiteError(`Admin account ${ADMIN_EMAIL} has 2FA enabled — cannot log in headlessly.`);
    }
    if (!data.token) throw new PrerequisiteError("Admin login returned no token.");
    return data.token;
  }
}

type Seeded = {
  onboardToken: string;
  amendToken: string;
  siteId: string;
  cleanup: () => Promise<void>;
};

/** Find an existing site, or create a throwaway client + site, so the
 *  authenticated Site Detail page (/sites/:id) renders a real record rather
 *  than its "Site not found" state. Returns the site id plus an optional
 *  cleanup that only removes rows this function created. */
async function seedSite(): Promise<{ siteId: string; cleanup: () => Promise<void> }> {
  const [existing] = await db.select({ id: sitesTable.id }).from(sitesTable).limit(1);
  if (existing) return { siteId: existing.id, cleanup: async () => {} };

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `A11y Probe Client ${randomBytes(4).toString("hex")}` })
    .returning({ id: clientsTable.id });
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: client.id, name: "A11y Probe Site", address: "1 Test Plaza" })
    .returning({ id: sitesTable.id });

  return {
    siteId: site.id,
    cleanup: async () => {
      // Deleting the client cascades to its sites (onDelete: "cascade").
      await db.delete(clientsTable).where(eq(clientsTable.id, client.id));
    },
  };
}

/** Mint short-lived onboarding + amendment tokens so the token-gated public
 *  forms actually render their fields (not the "invalid link" error state),
 *  and ensure a site exists for the authenticated Site Detail surface. */
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

  const { siteId, cleanup: cleanupSite } = await seedSite();

  async function cleanup() {
    await db.delete(onboardingTokensTable).where(eq(onboardingTokensTable.id, onboardRow.id));
    await db.delete(applicationAmendmentTokensTable).where(eq(applicationAmendmentTokensTable.id, amendRow.id));
    await db.delete(applicationsTable).where(eq(applicationsTable.id, app.id));
    await cleanupSite();
  }

  return { onboardToken, amendToken, siteId, cleanup };
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
    {
      name: "Pay Run page (/payroll/pay-run)",
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/payroll/pay-run`, adminToken);
        await page.getByRole("heading", { name: /pay run/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Applications HR page (/hr/applications)",
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/hr/applications`, adminToken);
        await page.getByRole("heading", { name: /applications/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Onboarding HR page (/hr/onboarding)",
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/hr/onboarding`, adminToken);
        await page.getByRole("heading", { name: /onboarding/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Audit Log page (/audit-log)",
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/audit-log`, adminToken);
        await page.getByRole("heading", { name: /audit log/i }).first().waitFor({ timeout: 20_000 });
      },
    },
    {
      name: "Site detail page (/sites/:id)",
      open: async (page) => {
        await openAuthed(page, `${PORTAL}/sites/${seeded.siteId}`, adminToken);
        // The header swaps the "Loading site…" placeholder for the site name
        // <h1> once the record resolves. Wait for that heading so axe scans the
        // populated page, not the loading state.
        await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20_000 });
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

  let spawned: ServiceHandle[] = [];
  let browser: Browser | null = null;
  let seeded: Seeded | null = null;
  let totalFailures = 0;
  let setupFailures = 0;

  try {
    // 1) Bring up (or reuse) the services and ensure the admin can log in.
    //    A failure here is an environment/prerequisite problem, not an a11y one.
    console.log("Preparing prerequisites…");
    spawned = await ensureServices();
    await ensureSeededAdmin();
    const adminToken = await adminLogin();
    seeded = await seedTokens();

    // 2) Run the actual scan.
    console.log("");
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
    if (seeded) await seeded.cleanup();
    await stopServices(spawned);
    await pool.end();
  }

  console.log("");
  if (setupFailures > 0) {
    console.error(`${setupFailures} surface(s) failed to load — cannot vouch for their accessibility.`);
  }
  if (totalFailures > 0) {
    console.error(`Accessibility scan FAILED: ${totalFailures} critical/serious violation(s).`);
  }
  if (totalFailures > 0 || setupFailures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("Accessibility scan passed: no critical/serious violations on any surface.");
}

main().catch((err) => {
  if (err instanceof PrerequisiteError) {
    // Prerequisite couldn't be satisfied — phrase this clearly so it's never
    // mistaken for an accessibility violation in CI / pre-deploy output.
    console.error(`\nAccessibility scan could not run — prerequisite not ready:\n  ${err.message}`);
  } else {
    console.error("Accessibility scan errored:", err);
  }
  process.exitCode = 1;
});
