/**
 * Feature-gate authorization tests.
 *
 * UI gating (admin portal FeatureGuard / mobile FeatureGate / hidden tabs)
 * only HIDES a surface — the authoritative gate is the server's
 * `requireFeature` middleware mounted in routes/index.ts. These tests assert
 * that for every gated product surface the server returns the
 * feature-disabled 403 when the flag is off, so a determined client cannot
 * reach the underlying data by calling the API directly.
 *
 * Feature-key sync is enforced structurally: both client packages re-export
 * `FeatureKey` from `@workspace/feature-keys` (the single source of truth),
 * so the TypeScript compiler prevents any divergence at build time. The tests
 * below assert that the re-export wiring has not been accidentally reverted to
 * a hand-maintained union.
 *
 * This file also asserts every server key is actually wired to a
 * `requireFeature(...)` call AND has a representative endpoint exercised below.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import {
  FEATURE_KEYS,
  type FeatureKey,
  setOverrideInMemory,
  clearOverrideInMemory,
} from "../lib/features";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const ADMIN_BRAND = path.join(REPO_ROOT, "artifacts/admin-portal/src/lib/brand.ts");
const MOBILE_FEATURES = path.join(
  REPO_ROOT,
  "artifacts/security-ops/hooks/useFeatures.ts",
);
const ROUTES_INDEX = path.join(HERE, "..", "routes", "index.ts");

/**
 * Lightweight source-of-truth map: every server feature key → one
 * representative gated endpoint. Keeping this map exhaustive (asserted
 * below) forces any newly added gated feature to also gain a 403 test.
 */
const FEATURE_ENDPOINTS: Record<FeatureKey, { method: "get" | "post"; path: string }> = {
  chat: { method: "get", path: "/api/chat/rooms" },
  radio: { method: "get", path: "/api/radio/channels" },
  incidents: { method: "get", path: "/api/incidents" },
  payroll: { method: "get", path: "/api/payroll" },
  invoicing: { method: "get", path: "/api/invoices" },
  hr: { method: "get", path: "/api/admin/application-fields" },
  liveMap: { method: "get", path: "/api/admin/active-officers" },
  policies: { method: "get", path: "/api/admin/policies" },
  swapRequests: { method: "get", path: "/api/me/swap-requests" },
  licenseRenewals: { method: "get", path: "/api/admin/license-renewals" },
  dar: { method: "get", path: "/api/me/dar" },
  exports: { method: "post", path: "/api/admin/exports/preview" },
  trainings: { method: "get", path: "/api/admin/trainings" },
  patrol: { method: "get", path: "/api/admin/patrol/scans" },
  availability: { method: "get", path: "/api/me/availability" },
  officerShares: { method: "get", path: "/api/admin/employee-shares" },
  assistant: { method: "get", path: "/api/assistant/status" },
};

const TAG = `feature-gate-test-${randomUUID().slice(0, 8)}`;

let adminToken = "";
let adminId = "";

async function ensureAdmin(): Promise<void> {
  if (adminToken) return;
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@example.test`,
      passwordHash: bcrypt.hashSync("test-password", 4),
      firstName: "Admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  adminId = row.id;
  adminToken = signToken({
    userId: adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });
}

function fire(ep: { method: "get" | "post"; path: string }) {
  const r = ep.method === "get" ? request(app).get(ep.path) : request(app).post(ep.path);
  return r.set({ Authorization: `Bearer ${adminToken}` }).send({});
}

/**
 * Assert that a client file re-exports FeatureKey from the shared package
 * rather than defining its own hand-maintained union.  The TypeScript
 * compiler already prevents divergence at build time; this test catches an
 * accidental reversion of the import wiring (e.g. someone replacing the
 * re-export with a local `export type FeatureKey = "chat" | ...` again).
 */
function assertReExportsFromSharedPackage(file: string): void {
  const src = readFileSync(file, "utf8");
  const hasLocalUnion = /export\s+type\s+FeatureKey\s*=\s*[^{]/.test(src);
  const hasReExport = /export\s+(?:type\s+)?\{[^}]*FeatureKey[^}]*\}\s+from\s+["']@workspace\/feature-keys["']/.test(src);
  if (hasLocalUnion) {
    throw new Error(
      `${file} defines its own FeatureKey union instead of re-exporting from @workspace/feature-keys.\n` +
      `Replace the local union with: export type { FeatureKey } from "@workspace/feature-keys";`,
    );
  }
  if (!hasReExport) {
    throw new Error(
      `${file} does not re-export FeatureKey from @workspace/feature-keys.\n` +
      `Add: export type { FeatureKey } from "@workspace/feature-keys";`,
    );
  }
}

/**
 * Pull every `requireFeature("x")` key referenced in any route file
 * (routes/index.ts excluded — gates now live inside the individual
 * router files, path-scoped so they only fire on that router's paths).
 */
function parseGatedKeys(): string[] {
  const routesDir = path.dirname(ROUTES_INDEX);
  const keys = new Set<string>();
  for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
    const src = readFileSync(path.join(routesDir, file), "utf8");
    for (const m of src.matchAll(/requireFeature\("([^"]+)"\)/g)) keys.add(m[1]);
  }
  return [...keys];
}

/**
 * Routers intentionally mounted WITHOUT a requireFeature() gate in
 * routes/index.ts. These are core/operational surfaces that ship in every
 * pricing tier — auth, health, admin CRUD, scheduling integration, the client
 * portal, public lead capture, etc.
 */
const CORE_UNGATED_ROUTERS = new Set<string>([
  "healthRouter",
  "authRouter",
  "employeesRouter",
  "clientsRouter",
  "sitesRouter",
  "shiftsRouter",
  // Protection-detail (PPO) package rides the core shifts surface; its own
  // route-level authz (admin or accepted-assignment officer) is the boundary.
  "protectionRouter",
  // Shared admin to-do list + HR completeness report: core admin surfaces.
  "adminTasksRouter",
  "employeeReportsRouter",
  "timeEntriesRouter",
  "licensesRouter",
  "dashboardRouter",
  "adminRouter",
  // Company-owner grant/revoke (requireCompanyOwner) and the custom-role
  // permission matrix (requireAdmin) — configuration surfaces, not a
  // paid/optional product tier.
  "companyOwnersRouter",
  "permissionsRouter",
  "storageRouter",
  "systemRouter",
  "platformRouter",
  "auditRouter",
  "notificationsRouter",
  "totpRouter",
  "brandConfigRouter",
  "orgDirectoryRouter",
  "clientPortalRouter",
  "subcontractorPayRunRouter",
  "subcontractorRouter",
  // Subcontractor (vendor) self-service portal — same footing as
  // clientPortalRouter above: an external-party account type, not a
  // paid/optional product tier.
  "subcontractorPortalRouter",
  "schedulerWebhookRouter",
  "schedulerAdminRouter",
  "controlPlaneRouter",
  "paymentDiscrepanciesRouter",
  "leadsRouter",
  // Global search: ungated at the router level; per-domain isFeatureEnabled
  // guards inside the route handler exclude disabled-feature data (same pattern
  // as dashboardRouter). See routes/search.ts and globalSearch.test.ts.
  "searchRouter",
  // Analytics: core admin-only reporting over hours/coverage/incidents plus
  // payroll/invoicing-derived money figures; ships in every tier (the nav item
  // in the admin portal is likewise ungated). See routes/analytics.ts.
  "analyticsRouter",
  // Platform legal-agreement signing (MSA / User Agreement): super-admin-gated
  // vendor paperwork surface, not a per-tier paid feature — every deployment
  // must be able to execute its agreements. See routes/agreementSignatures.ts.
  "agreementSignaturesRouter",
  // App-version roster + install-the-new-app notice: core operational tooling
  // for migrating officers off the retired legacy app; admin/dispatcher-only
  // via route-level authz, not a per-tier paid feature. See routes/appVersions.ts.
  "appVersionsRouter",
]);

/**
 * Routers that apply requireFeature() *inside* the router file via a
 * path-scoped `router.use(path, requireFeature("key"))` call, rather than
 * at the outer mount in routes/index.ts.
 *
 * This is the correct pattern: the gate fires only when one of that
 * router's own paths is matched, so disabling one feature cannot
 * accidentally block unrelated endpoints that happen to be mounted later
 * in the main stack.
 *
 * Adding a new router to routes/index.ts forces a deliberate choice:
 *   • new paid/optional surface  → add requireFeature() inside the router
 *     file AND add its name here.
 *   • genuinely core surface      → add it to CORE_UNGATED_ROUTERS above.
 * The guard test below fails loudly if a router is neither — preventing
 * new paid product areas from shipping un-gated by accident.
 */
const SELF_GATED_ROUTERS = new Set<string>([
  "payrollRouter",
  "invoicesRouter",
  "incidentsRouter",
  "chatRouter",
  "liveOpsRouter",
  "applicationsRouter",
  "policiesRouter",
  "myPayrollRouter",
  "shiftSwapsRouter",
  "licenseRenewalsRouter",
  "incidentSharesRouter",
  "employeeSharesRouter",
  "availabilityRouter",
  "patrolRouter",
  "darRouter",
  "trainingsRouter",
  "exportsRouter",
  "radioRouter",
  "dispatchRouter",
  "assistantRouter",
]);

/**
 * Enumerate every `router.use(...)` mount in routes/index.ts that wires up a
 * `*Router`, recording whether the same mount also applies a requireFeature()
 * gate. Pure middleware mounts (e.g. auditLogMiddleware) carry no `*Router`
 * token and are skipped.
 */
function parseMountedRouters(): Array<{ name: string; gated: boolean }> {
  const src = readFileSync(ROUTES_INDEX, "utf8");
  const out: Array<{ name: string; gated: boolean }> = [];
  for (const m of src.matchAll(/router\.use\(([\s\S]*?)\);/g)) {
    const args = m[1];
    const nameMatch = args.match(/(\w+Router)\b/);
    if (!nameMatch) continue;
    out.push({ name: nameMatch[1], gated: /requireFeature\(/.test(args) });
  }
  return out;
}

afterEach(() => {
  // Never leak a forced override into a sibling test.
  for (const k of FEATURE_KEYS) clearOverrideInMemory(k);
});

describe("feature key sync (UI ⇄ server)", () => {
  const serverSorted = [...FEATURE_KEYS].sort();

  it("admin portal re-exports FeatureKey from @workspace/feature-keys (not a hand-maintained union)", () => {
    assertReExportsFromSharedPackage(ADMIN_BRAND);
  });

  it("mobile re-exports FeatureKey from @workspace/feature-keys (not a hand-maintained union)", () => {
    assertReExportsFromSharedPackage(MOBILE_FEATURES);
  });

  it("every server feature key is actually gated by requireFeature(...)", () => {
    const gated = new Set(parseGatedKeys());
    for (const key of FEATURE_KEYS) {
      expect(gated.has(key), `feature '${key}' has no requireFeature() gate`).toBe(true);
    }
  });

  it("requireFeature(...) is only used with known feature keys", () => {
    const known = new Set<string>(FEATURE_KEYS);
    for (const key of parseGatedKeys()) {
      expect(known.has(key), `unknown feature key '${key}' in routes/index.ts`).toBe(true);
    }
  });

  it("the endpoint map covers exactly the server feature keys", () => {
    expect(Object.keys(FEATURE_ENDPOINTS).sort()).toEqual(serverSorted);
  });
});

describe("ungated-feature guard (every mounted router is gated or explicitly core)", () => {
  const mounted = parseMountedRouters();

  it("discovers the routers mounted in routes/index.ts", () => {
    // Sanity: the parser actually found the mounts (guards against a future
    // refactor that silently changes the `router.use(...)` shape and makes the
    // guard below vacuously pass).
    expect(mounted.length).toBeGreaterThan(20);
  });

  it("every router is on the core allow-list or is self-gated inside its router file", () => {
    for (const r of mounted) {
      if (r.gated) continue; // outer gate in index.ts (legacy / rare)
      if (SELF_GATED_ROUTERS.has(r.name)) continue; // inner gate in router file (preferred)
      expect(
        CORE_UNGATED_ROUTERS.has(r.name),
        `\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `UNGATED ROUTER: '${r.name}'\n` +
          `\n` +
          `'${r.name}' was added to routes/index.ts but was not registered on\n` +
          `either allow-list in src/__tests__/featureGating.test.ts.\n` +
          `\n` +
          `You must make a deliberate choice and update featureGating.test.ts:\n` +
          `\n` +
          `  ① Paid or optional product surface (needs a feature gate)\n` +
          `     a. Inside the router file, add a path-scoped gate:\n` +
          `          router.use(["/your-path", "/your-path/:id"], requireFeature("<key>"));\n` +
          `     b. Add '${r.name}' to SELF_GATED_ROUTERS in featureGating.test.ts.\n` +
          `     c. Add a representative {method, path} entry to FEATURE_ENDPOINTS.\n` +
          `     d. Add the new key to FEATURE_KEYS (lib/features.ts) and the\n` +
          `        FeatureKey unions in admin-portal and security-ops.\n` +
          `\n` +
          `  ② Genuinely core — ships in every pricing tier (no gate needed)\n` +
          `     Add '${r.name}' to CORE_UNGATED_ROUTERS in featureGating.test.ts.\n` +
          `\n` +
          `See the comment block above router.use() calls in routes/index.ts\n` +
          `for the full convention.\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ).toBe(true);
    }
  });

  it("every self-gated router file actually calls requireFeature()", () => {
    const routesDir = path.dirname(ROUTES_INDEX);
    for (const name of SELF_GATED_ROUTERS) {
      // "payrollRouter" → "payroll.ts", "myPayrollRouter" → "myPayroll.ts", etc.
      const fileName = name.replace(/Router$/, "") + ".ts";
      const filePath = path.join(routesDir, fileName);
      const src = readFileSync(filePath, "utf8");
      expect(
        /requireFeature\(/.test(src),
        `'${name}' is in SELF_GATED_ROUTERS but ${fileName} contains no requireFeature() call — ` +
          `add a path-scoped gate at the top of the router file or remove it from SELF_GATED_ROUTERS.`,
      ).toBe(true);
    }
  });

  it("every route path in each self-gated router is covered by its gate prefixes", () => {
    const routesDir = path.dirname(ROUTES_INDEX);
    for (const name of SELF_GATED_ROUTERS) {
      const fileName = name.replace(/Router$/, "") + ".ts";
      const src = readFileSync(path.join(routesDir, fileName), "utf8");

      // Extract gate prefixes from path-scoped requireFeature() calls.
      // Supports both array form: router.use(["/a", "/b"], requireFeature(...))
      // and single-string form: router.use("/a", requireFeature(...))
      const gatePrefixes: string[] = [];
      for (const m of src.matchAll(/router\.use\(\s*(\[[\s\S]*?\]|"[^"]*")\s*,\s*requireFeature\(/g)) {
        const arg = m[1].trim();
        if (arg.startsWith("[")) {
          for (const p of arg.matchAll(/"([^"]+)"/g)) gatePrefixes.push(p[1]);
        } else {
          const p = arg.match(/"([^"]+)"/);
          if (p) gatePrefixes.push(p[1]);
        }
      }

      // Extract all route handler paths: router.get/post/put/delete/patch/all("path", ...)
      const routePaths: string[] = [];
      for (const m of src.matchAll(/router\.(get|post|put|delete|patch|all)\s*\(\s*"([^"]+)"/g)) {
        routePaths.push(m[2]);
      }

      for (const routePath of routePaths) {
        const covered = gatePrefixes.some(
          (prefix) => routePath === prefix || routePath.startsWith(prefix + "/"),
        );
        expect(
          covered,
          `Route path '${routePath}' in ${fileName} is NOT covered by any gate prefix.\n` +
            `Current gate prefixes: ${JSON.stringify(gatePrefixes)}\n` +
            `Add the missing prefix (e.g. '${routePath.split("/").slice(0, 3).join("/")}') ` +
            `to the router.use([...], requireFeature(...)) call at the top of ${fileName}.`,
        ).toBe(true);
      }
    }
  });

  it("the core allow-list has no stale entries (every listed router is still mounted)", () => {
    const mountedNames = new Set(mounted.map((r) => r.name));
    for (const name of CORE_UNGATED_ROUTERS) {
      expect(
        mountedNames.has(name),
        `'${name}' is in CORE_UNGATED_ROUTERS but no longer mounted in routes/index.ts — remove it.`,
      ).toBe(true);
    }
  });

  it("the self-gated list has no stale entries (every listed router is still mounted)", () => {
    const mountedNames = new Set(mounted.map((r) => r.name));
    for (const name of SELF_GATED_ROUTERS) {
      expect(
        mountedNames.has(name),
        `'${name}' is in SELF_GATED_ROUTERS but no longer mounted in routes/index.ts — remove it.`,
      ).toBe(true);
    }
  });

  it("no router appears in both the core allow-list and the self-gated list", () => {
    for (const name of SELF_GATED_ROUTERS) {
      expect(
        CORE_UNGATED_ROUTERS.has(name),
        `'${name}' appears in both CORE_UNGATED_ROUTERS and SELF_GATED_ROUTERS — ` +
          `remove it from one list so the intent is unambiguous.`,
      ).toBe(false);
    }
  });
});

describe("gated endpoints block data access when the flag is off", () => {
  it("returns the feature-disabled 403 for every gated surface", async () => {
    await ensureAdmin();
    for (const key of FEATURE_KEYS) {
      const ep = FEATURE_ENDPOINTS[key];

      // Flag ON (default): the endpoint must NOT be blocked by the feature
      // gate. It may still 4xx for other reasons (empty body, role), but it
      // must not be the feature-disabled 403 — proving the gate, not auth,
      // is what blocks below.
      const on = await fire(ep);
      expect(
        on.status === 403 && on.body?.feature === key,
        `${ep.method.toUpperCase()} ${ep.path} should NOT be feature-blocked when '${key}' is enabled (got ${on.status})`,
      ).toBe(false);

      // Flag OFF: the server must short-circuit with the documented
      // feature-disabled 403 regardless of the caller's (admin) auth.
      setOverrideInMemory(key, false);
      const off = await fire(ep);
      expect(off.status, `${ep.method.toUpperCase()} ${ep.path} with '${key}' off`).toBe(403);
      expect(off.body?.error).toBe("Forbidden");
      expect(off.body?.feature).toBe(key);
      expect(off.body?.message).toContain(key);
      clearOverrideInMemory(key);
    }
  });

  it("a disabled feature blocks unauthenticated callers too (gate runs before auth)", async () => {
    setOverrideInMemory("payroll", false);
    const res = await request(app).get("/api/payroll").send();
    expect(res.status).toBe(403);
    expect(res.body?.feature).toBe("payroll");
  });

  it("disabling payroll does not block GET /dashboard/admin-summary", async () => {
    await ensureAdmin();
    setOverrideInMemory("payroll", false);
    const res = await request(app)
      .get("/api/dashboard/admin-summary")
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(
      res.status === 403 && res.body?.feature === "payroll",
      `GET /dashboard/admin-summary returned 403 with feature=payroll — ` +
        `the payroll gate is bleeding into an unrelated endpoint`,
    ).toBe(false);
    // Dashboard should respond normally (200) regardless of payroll state.
    expect(res.status).toBe(200);
  });

  it("disabling chat does not block GET /api/shifts", async () => {
    await ensureAdmin();
    setOverrideInMemory("chat", false);
    const res = await request(app)
      .get("/api/shifts")
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(
      res.status === 403 && res.body?.feature === "chat",
      `GET /shifts returned 403 with feature=chat — ` +
        `the chat gate is bleeding into an unrelated endpoint`,
    ).toBe(false);
    expect(res.status).toBe(200);
  });

  it("GET /me/patrol/recent is blocked when patrol is disabled (gate-coverage regression)", async () => {
    await ensureAdmin();
    setOverrideInMemory("patrol", false);
    const res = await request(app)
      .get("/api/me/patrol/recent")
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status, "GET /me/patrol/recent must 403 when patrol is disabled").toBe(403);
    expect(res.body?.feature).toBe("patrol");
  });
});

afterEach(async () => {
  // Final cleanup of the seeded admin happens once at suite end via the
  // shared pool; remove our tagged user defensively here too.
  if (!adminId) return;
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  adminId = "";
  adminToken = "";
});
