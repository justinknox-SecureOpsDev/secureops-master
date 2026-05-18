/**
 * Integration test: dispatcher role allow/deny matrix.
 *
 * Verifies that a user with role=dispatcher can reach the operational
 * endpoints in scope (Dispatch panels, shifts read/assign/notify,
 * incidents read/comment, chat membership, personnel read), and is
 * BLOCKED from out-of-scope endpoints (payroll, invoices, HR,
 * audit, generic admin CRUD, system status).
 *
 * Also asserts that a regular employee is blocked from dispatch and
 * admin-only routes, so the widening for dispatcher hasn't quietly
 * widened things for employees too.
 *
 * Hits the live API through the shared proxy at http://localhost:80.
 * Requires the demo seed (admin@secureops.com / Admin123!) to be
 * enabled and a regular employee row that has logged in at least
 * once (john.smith@secureops.com / Employee123!).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run test-dispatcher-authz
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

const BASE = process.env.TEST_API_BASE ?? "http://localhost:80";
const ADMIN_EMAIL = "admin@secureops.com";
const ADMIN_PW = "Admin123!";
const EMP_EMAIL = "john.smith@secureops.com";
const EMP_PW = "Employee123!";
const DISP_EMAIL = "dispatcher.test@secureops.com";
const DISP_PW = "Dispatch123!";

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  const j = await r.json() as { token?: string };
  if (!j.token) throw new Error(`no token for ${email}`);
  return j.token;
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<number> {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // Drain body to avoid leaking sockets.
  try { await r.text(); } catch { /* noop */ }
  return r.status;
}

async function getJson<T = unknown>(path: string, token: string): Promise<{ status: number; data: T | null }> {
  const r = await fetch(`${BASE}/api${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  let data: T | null = null;
  try { data = await r.json() as T; } catch { /* noop */ }
  return { status: r.status, data };
}

async function ensureDispatcher(): Promise<void> {
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, DISP_EMAIL));
  const hash = await bcrypt.hash(DISP_PW, 10);
  if (existing) {
    await db.update(usersTable)
      .set({ role: "dispatcher", status: "active", passwordHash: hash, mustChangePassword: false })
      .where(eq(usersTable.id, existing.id));
  } else {
    await db.insert(usersTable).values({
      email: DISP_EMAIL, passwordHash: hash, firstName: "Dispatch",
      lastName: "Tester", role: "dispatcher", status: "active",
    });
  }
}

const allowed = (s: number) => s >= 200 && s < 400;
const forbidden = (s: number) => s === 403 || s === 401;

test("dispatcher role allow/deny matrix", async (t) => {
  await ensureDispatcher();
  const adminTok = await login(ADMIN_EMAIL, ADMIN_PW);
  const dispTok = await login(DISP_EMAIL, DISP_PW);
  let empTok: string | null = null;
  try { empTok = await login(EMP_EMAIL, EMP_PW); } catch { /* demo seed off, skip emp checks */ }

  await t.test("dispatcher CAN reach in-scope endpoints", async () => {
    for (const path of [
      "/dispatch/status-board",
      "/dispatch/open-shifts",
      "/dispatch/active-incidents",
      "/dispatch/broadcast-rooms",
      "/admin/active-officers",
      "/shifts?status=upcoming",
      "/incidents",
      "/employees",
      "/sites",
      "/chat/rooms",
    ]) {
      const s = await call("GET", path, dispTok);
      assert.ok(allowed(s), `expected 2xx/3xx for ${path}, got ${s}`);
    }
  });

  await t.test("dispatcher CANNOT reach out-of-scope endpoints", async () => {
    const checks: Array<[string, string]> = [
      ["GET", "/admin/system/status"],
      ["GET", "/admin/audit-logs"],
      ["GET", "/dashboard/admin-summary"],
      ["GET", "/admin/tables/users"],
      ["GET", "/admin/tables/clients"],
      ["GET", "/admin/tables/invoices"],
      ["GET", "/admin/tables/payroll_entries"],
      ["GET", "/admin/tables/employees"],
      ["GET", "/admin/tables/sites"],
      ["GET", "/admin/tables/incidents"],
      ["GET", "/admin/applications"],
      ["GET", "/admin/users/invitations"],
      ["POST", "/payroll/pay-run/preview"],
    ];
    for (const [m, p] of checks) {
      const s = await call(m, p, dispTok, m === "POST" ? { ids: [] } : undefined);
      assert.ok(forbidden(s), `expected 401/403 for ${m} ${p} (dispatcher), got ${s}`);
    }
  });

  if (empTok) {
    await t.test("employee CANNOT reach dispatch endpoints", async () => {
      for (const path of [
        "/dispatch/status-board",
        "/dispatch/open-shifts",
        "/dispatch/active-incidents",
        "/admin/active-officers",
      ]) {
        const s = await call("GET", path, empTok!);
        assert.ok(forbidden(s), `expected 401/403 for ${path} (employee), got ${s}`);
      }
    });
  }

  await t.test("dispatcher /employees payload is field-restricted (no HR/payroll PII)", async () => {
    // Sensitive HR/payroll/personal fields that MUST NOT appear when
    // a dispatcher token fetches the personnel roster or a single
    // officer card. Admins still get the full projection.
    const FORBIDDEN_FIELDS = [
      "bankAccountName", "bankAccountNumber", "bankBsb", "taxCode",
      "niNumber", "dateOfBirth", "cityOfBirth", "stateOfBirth",
      "rightToWorkStatus", "rightToWorkDocKey",
      "passportDocKey", "licenseDocKey", "photoKey", "cvKey", "payStubDocKey",
      "trainingCertificateKeys", "references", "previousExperience",
      "directDepositConsent", "directDepositSignature", "acknowledgements",
      "hourlyRate", "skills", "availability",
    ];

    const list = await getJson<Array<Record<string, unknown>>>("/employees", dispTok);
    assert.equal(list.status, 200, `dispatcher GET /employees -> ${list.status}`);
    assert.ok(Array.isArray(list.data), "dispatcher /employees should return an array");
    for (const row of list.data ?? []) {
      for (const f of FORBIDDEN_FIELDS) {
        assert.ok(!(f in row), `dispatcher /employees row leaked field "${f}"`);
      }
    }

    // Admin baseline: at least one row should include at least one of
    // the restricted fields, proving the projection difference is real
    // (and the test isn't passing because the schema lost the field).
    const adminList = await getJson<Array<Record<string, unknown>>>("/employees", adminTok);
    assert.equal(adminList.status, 200);
    const anySensitiveForAdmin = (adminList.data ?? []).some((r) =>
      FORBIDDEN_FIELDS.some((f) => f in r)
    );
    assert.ok(anySensitiveForAdmin, "admin /employees should still expose sensitive HR fields (sanity)");

    // Single-employee endpoint must apply the same projection.
    const firstId = (list.data ?? [])[0]?.id as string | undefined;
    if (firstId) {
      const one = await getJson<Record<string, unknown>>(`/employees/${firstId}`, dispTok);
      assert.equal(one.status, 200, `dispatcher GET /employees/:id -> ${one.status}`);
      for (const f of FORBIDDEN_FIELDS) {
        assert.ok(!(f in (one.data ?? {})), `dispatcher /employees/:id leaked field "${f}"`);
      }
    }
  });

  await t.test("admin still reaches everything", async () => {
    for (const path of [
      "/dispatch/status-board",
      "/dashboard/admin-summary",
      "/admin/system/status",
      "/admin/audit-logs",
    ]) {
      const s = await call("GET", path, adminTok);
      assert.ok(allowed(s), `expected 2xx/3xx for ${path} (admin), got ${s}`);
    }
  });
});
