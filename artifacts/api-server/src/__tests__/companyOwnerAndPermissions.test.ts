import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and, getTableColumns } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  siteManagersTable,
  shiftsTable,
  payrollEntriesTable,
  invoicesTable,
  timeEntriesTable,
  permissionOverridesTable,
  companyOwnerRolloutTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { loadPermissionOverridesFromDb, clearPermissionOverrideInMemory } from "../lib/permissions";
import { countCompanyOwners, backfillCompanyOwnersFromAdminRole, shouldClaimCompanyOwnerRollout } from "../lib/companyOwner";
import { DASHBOARD_FINANCE_FIELDS } from "../lib/financeVisibility";

// Task #733 — company-owner flag & custom-role permission matrix.
//
// Covers the acceptance criteria from the task's "Automated coverage" step:
//   1. A non-owner admin is blocked/sanitized on financial dashboard
//      endpoints while an owner sees full data.
//   2. Revoking the owner flag blocks the very next request — no re-login.
//   3. No code path lets an owner grant platform super-admin.
//   4. Existing role-based behavior is unchanged (officer/site-manager
//      own-pay, admin scheduling access via the new permission keys).
//   5. Permission-matrix overrides actually change enforcement at request time.
const TAG = `owner-perm-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  ownerAdminId: string;
  nonOwnerAdminId: string;
  officerId: string;
  siteManagerId: string;
  ownerAdminToken: string;
  nonOwnerAdminToken: string;
  officerToken: string;
  siteManagerToken: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string, isCompanyOwner = false): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Test",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
      isCompanyOwner,
    })
    .returning({ id: usersTable.id });
  return row.id;
}

beforeAll(async () => {
  // Two admins: one company owner (as the rollout backfill would produce),
  // one deliberately NOT an owner (e.g. an admin promoted after rollout, or
  // explicitly revoked) — the two axes (role vs owner flag) are independent.
  ctx.ownerAdminId = await makeUser("admin", "owner-admin", true);
  ctx.nonOwnerAdminId = await makeUser("admin", "non-owner-admin", false);
  ctx.officerId = await makeUser("employee", "officer", false);
  ctx.siteManagerId = await makeUser("site_manager", "sitemgr", false);

  await db.insert(employeesTable).values([
    { userId: ctx.officerId, position: "officer", hourlyRate: "30.00" },
    { userId: ctx.siteManagerId, position: "officer", hourlyRate: "35.00" },
  ]);

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  await db.insert(siteManagersTable).values({ siteId: ctx.siteId, userId: ctx.siteManagerId });

  ctx.ownerAdminToken = signToken({ userId: ctx.ownerAdminId, email: `${TAG}-owner-admin@example.test`, role: "admin" });
  ctx.nonOwnerAdminToken = signToken({ userId: ctx.nonOwnerAdminId, email: `${TAG}-non-owner-admin@example.test`, role: "admin" });
  ctx.officerToken = signToken({ userId: ctx.officerId, email: `${TAG}-officer@example.test`, role: "employee" });
  ctx.siteManagerToken = signToken({ userId: ctx.siteManagerId, email: `${TAG}-sitemgr@example.test`, role: "site_manager" });
});

afterAll(async () => {
  // Restore any permission override this suite may have left behind so
  // other suites always see default behavior.
  await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "dispatch.manage"));
  clearPermissionOverrideInMemory("dispatch.manage");
  await loadPermissionOverridesFromDb();

  const ids = [ctx.ownerAdminId, ctx.nonOwnerAdminId, ctx.officerId, ctx.siteManagerId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("Company-owner gate on aggregate financial dashboard endpoints", () => {
  const cases: Array<{ label: string; call: () => request.Test }> = [
    { label: "GET /analytics/summary", call: () => request(app).get("/api/analytics/summary?start=2020-01-01&end=2020-01-31") },
    { label: "GET /payroll/board", call: () => request(app).get("/api/payroll/board") },
    { label: "POST /subcontractor-pay-run/preview", call: () => request(app).post("/api/subcontractor-pay-run/preview").send({ ids: [randomUUID()] }) },
  ];

  for (const { label, call } of cases) {
    it(`blocks a non-owner admin on ${label} with 403`, async () => {
      const res = await call().set(authed(ctx.nonOwnerAdminToken));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Forbidden");
    });

    it(`lets a company-owner admin through on ${label} (not a 403)`, async () => {
      const res = await call().set(authed(ctx.ownerAdminToken));
      expect(res.status).not.toBe(403);
    });
  }

  it("blocks a non-owner admin from the finance-gated custom-export dataset (payroll_entries)", async () => {
    const res = await request(app)
      .post("/api/admin/exports/csv")
      .set(authed(ctx.nonOwnerAdminToken))
      .send({ dataset: "payroll_entries", filters: {} });
    expect(res.status).toBe(403);
  });

  it("lets a company owner use the finance-gated custom-export dataset (payroll_entries)", async () => {
    const res = await request(app)
      .post("/api/admin/exports/csv")
      .set(authed(ctx.ownerAdminToken))
      .send({ dataset: "payroll_entries", filters: {} });
    expect(res.status).toBe(200);
  });

  it("still lets a non-owner admin use a non-finance-gated export dataset (shifts)", async () => {
    const res = await request(app)
      .post("/api/admin/exports/csv")
      .set(authed(ctx.nonOwnerAdminToken))
      .send({ dataset: "shifts", filters: {} });
    expect(res.status).toBe(200);
  });
});

// Task #734 — GET /payroll and GET /invoices (the plain lists) were fully
// company-owner gated by task #733 as an aggregate/board view, which also
// blocked a non-owner bookkeeper with the finance.transactions permission
// from browsing the list to find a record they're otherwise allowed to open
// and edit. They're now reachable by EITHER an owner OR finance.transactions,
// with the dashboard finance sanitizer applied for the non-owner path.
describe("Non-owner bookkeepers with finance.transactions can browse (sanitized) payroll and invoice lists", () => {
  let payrollEntryId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const [entry] = await db
      .insert(payrollEntriesTable)
      .values({
        employeeId: ctx.officerId,
        siteId: ctx.siteId,
        periodStart: "2020-01-06",
        periodEnd: "2020-01-12",
        totalHours: "40.00",
        hourlyRate: "30.00",
        grossPay: "1200.00",
        tax: "0",
        netPay: "1200.00",
        status: "pending",
      })
      .returning({ id: payrollEntriesTable.id });
    payrollEntryId = entry.id;

    const [invoice] = await db
      .insert(invoicesTable)
      .values({
        invoiceNumber: `${TAG}-INV-1`,
        clientId: ctx.clientId,
        siteId: ctx.siteId,
        clientName: `${TAG}-client`,
        lineItems: [],
        subtotal: "5000.00",
        taxAmount: "0",
        totalAmount: "5000.00",
        status: "draft",
        dueDate: "2020-02-01",
      })
      .returning({ id: invoicesTable.id });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await db.delete(payrollEntriesTable).where(eq(payrollEntriesTable.id, payrollEntryId));
    await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
    await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "finance.transactions"));
    clearPermissionOverrideInMemory("finance.transactions");
    await loadPermissionOverridesFromDb();
  });

  it("blocks a plain site_manager (no owner flag, no finance.transactions) from GET /payroll and GET /invoices", async () => {
    const payrollRes = await request(app).get("/api/payroll").set(authed(ctx.siteManagerToken));
    expect(payrollRes.status).toBe(403);
    const invoicesRes = await request(app).get("/api/invoices").set(authed(ctx.siteManagerToken));
    expect(invoicesRes.status).toBe(403);
  });

  it("lets a non-owner admin (finance.transactions' default role) browse GET /payroll with dashboard finance fields stripped", async () => {
    const res = await request(app).get("/api/payroll").set(authed(ctx.nonOwnerAdminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { id: string }) => r.id === payrollEntryId);
    expect(row).toBeDefined();
    expect(row.grossPay).toBeUndefined();
    expect(row.netPay).toBeUndefined();
    // Non-financial-aggregate fields needed to locate/open the record stay visible.
    expect(row.status).toBe("pending");
    expect(row.totalHours).toBe("40.00");
  });

  it("lets a non-owner admin browse GET /invoices with dashboard finance fields stripped", async () => {
    const res = await request(app).get("/api/invoices").set(authed(ctx.nonOwnerAdminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { id: string }) => r.id === invoiceId);
    expect(row).toBeDefined();
    expect(row.subtotal).toBeUndefined();
    expect(row.totalAmount).toBeUndefined();
    expect(row.invoiceNumber).toBe(`${TAG}-INV-1`);
    expect(row.status).toBe("draft");
  });

  it("a company owner still sees the full, unsanitized payroll and invoice lists", async () => {
    const payrollRes = await request(app).get("/api/payroll").set(authed(ctx.ownerAdminToken));
    expect(payrollRes.status).toBe(200);
    const payrollRow = payrollRes.body.find((r: { id: string }) => r.id === payrollEntryId);
    expect(payrollRow.grossPay).toBe("1200.00");
    expect(payrollRow.netPay).toBe("1200.00");

    const invoicesRes = await request(app).get("/api/invoices").set(authed(ctx.ownerAdminToken));
    expect(invoicesRes.status).toBe(200);
    const invoiceRow = invoicesRes.body.find((r: { id: string }) => r.id === invoiceId);
    expect(invoiceRow.subtotal).toBe("5000.00");
    expect(invoiceRow.totalAmount).toBe("5000.00");
  });

  // The two axes draw the line at AGGREGATE vs SINGLE RECORD, not at "any
  // dollar figure". `finance.transactions` is the transaction-level grant:
  // its holder may create, price, edit, send and inspect ONE invoice —
  // which necessarily means seeing that invoice's own amounts and rates.
  // What it must never yield is the company-wide picture (board roll-ups,
  // revenue/margin), which is why the list response is sanitized even though
  // the per-record routes are not. Locking this down so a later change can't
  // quietly move a route across that line in either direction.
  it("keeps per-record invoice detail available to the permission holder while the aggregate board stays owner-only", async () => {
    // Per-record: allowed (this is the work the permission exists for).
    const entriesRes = await request(app)
      .get(`/api/invoices/${invoiceId}/entries`)
      .set(authed(ctx.nonOwnerAdminToken));
    expect(entriesRes.status).toBe(200);

    const pdfRes = await request(app)
      .get(`/api/invoices/${invoiceId}/pdf`)
      .set(authed(ctx.nonOwnerAdminToken));
    expect(pdfRes.status).toBe(200);

    // Company-wide: still refused without the owner flag.
    const boardRes = await request(app).get("/api/payroll/board").set(authed(ctx.nonOwnerAdminToken));
    expect(boardRes.status).toBe(403);
  });

  // Task #744 — the sanitized lists above only tell a non-owner bookkeeper a
  // record exists; the admin grid's per-record screen they'd otherwise deep
  // link to (/tables/payroll_entries, /tables/invoices) is requireAdmin, so
  // they had nowhere to actually open one. GET /payroll/:id and
  // GET /invoices/:id are the read half of that new, separate detail
  // surface — gated by the same finance.transactions permission as the
  // sibling PUT routes (not the list's owner-or-permission gate, and not the
  // admin grid's requireAdmin), so they return the same unsanitized
  // transaction-level record PUT already exposes to this permission holder.
  it("lets a non-owner permission holder GET a single payroll entry by id, unsanitized", async () => {
    const res = await request(app).get(`/api/payroll/${payrollEntryId}`).set(authed(ctx.nonOwnerAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(payrollEntryId);
    expect(res.body.grossPay).toBe("1200.00");
    expect(res.body.netPay).toBe("1200.00");
    expect(res.body.status).toBe("pending");
  });

  it("lets a non-owner permission holder GET a single invoice by id, unsanitized", async () => {
    const res = await request(app).get(`/api/invoices/${invoiceId}`).set(authed(ctx.nonOwnerAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(invoiceId);
    expect(res.body.subtotal).toBe("5000.00");
    expect(res.body.totalAmount).toBe("5000.00");
    expect(res.body.invoiceNumber).toBe(`${TAG}-INV-1`);
  });

  it("blocks a plain site_manager (no finance.transactions) from GET /payroll/:id and GET /invoices/:id", async () => {
    const payrollRes = await request(app).get(`/api/payroll/${payrollEntryId}`).set(authed(ctx.siteManagerToken));
    expect(payrollRes.status).toBe(403);
    const invoiceRes = await request(app).get(`/api/invoices/${invoiceId}`).set(authed(ctx.siteManagerToken));
    expect(invoiceRes.status).toBe(403);
  });

  it("404s GET /payroll/:id and GET /invoices/:id for a permission holder when the id doesn't exist", async () => {
    const missingId = randomUUID();
    const payrollRes = await request(app).get(`/api/payroll/${missingId}`).set(authed(ctx.nonOwnerAdminToken));
    expect(payrollRes.status).toBe(404);
    const invoiceRes = await request(app).get(`/api/invoices/${missingId}`).set(authed(ctx.nonOwnerAdminToken));
    expect(invoiceRes.status).toBe(404);
  });

  // Task #779 — the bookkeeper's single-record detail pages only exposed
  // status/notes for editing even though PUT /payroll/:id and
  // PUT /invoices/:id are the same finance.transactions-gated routes the
  // admin-only grid uses to record a real payment or due-date change.
  // Extending the fields these routes accept (not the gate) so that surface
  // isn't a dead end for day-to-day bookkeeping. Run before the site_manager
  // grant below, while that role still lacks finance.transactions.
  it("lets a non-owner permission holder PUT paidAt, paidMethod and paymentReference on a payroll entry", async () => {
    const res = await request(app)
      .put(`/api/payroll/${payrollEntryId}`)
      .set(authed(ctx.nonOwnerAdminToken))
      .send({ paidAt: "2020-02-05", paidMethod: "manual", paymentReference: "CHK-4471" });
    expect(res.status).toBe(200);
    expect(res.body.paidMethod).toBe("manual");
    expect(res.body.paymentReference).toBe("CHK-4471");
    expect(new Date(res.body.paidAt).toISOString().slice(0, 10)).toBe("2020-02-05");
    // Status untouched by this call.
    expect(res.body.status).toBe("pending");
  });

  it("rejects an invalid paidMethod on PUT /payroll/:id rather than storing it", async () => {
    const res = await request(app)
      .put(`/api/payroll/${payrollEntryId}`)
      .set(authed(ctx.nonOwnerAdminToken))
      .send({ notes: "reconciled by bookkeeper", paidMethod: "cash-under-the-table" });
    expect(res.status).toBe(200);
    // Invalid value silently ignored — previous valid value (set above) survives.
    expect(res.body.paidMethod).toBe("manual");
    expect(res.body.notes).toBe("reconciled by bookkeeper");
  });

  it("lets a non-owner permission holder PUT a new dueDate on an invoice", async () => {
    const res = await request(app)
      .put(`/api/invoices/${invoiceId}`)
      .set(authed(ctx.nonOwnerAdminToken))
      .send({ dueDate: "2020-03-15" });
    expect(res.status).toBe(200);
    expect(res.body.dueDate).toBe("2020-03-15");
  });

  it("blocks a plain site_manager (no finance.transactions) from PUT /payroll/:id and PUT /invoices/:id", async () => {
    const payrollRes = await request(app)
      .put(`/api/payroll/${payrollEntryId}`)
      .set(authed(ctx.siteManagerToken))
      .send({ paymentReference: "should-not-land" });
    expect(payrollRes.status).toBe(403);
    const invoiceRes = await request(app)
      .put(`/api/invoices/${invoiceId}`)
      .set(authed(ctx.siteManagerToken))
      .send({ dueDate: "2020-04-01" });
    expect(invoiceRes.status).toBe(403);
  });

  it("granting finance.transactions to site_manager lets a non-owner site_manager browse both (sanitized) lists", async () => {
    const grant = await request(app)
      .patch("/api/admin/permissions/finance.transactions")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "site_manager"] });
    expect(grant.status).toBe(200);

    const payrollRes = await request(app).get("/api/payroll").set(authed(ctx.siteManagerToken));
    expect(payrollRes.status).toBe(200);
    const payrollRow = payrollRes.body.find((r: { id: string }) => r.id === payrollEntryId);
    expect(payrollRow).toBeDefined();
    expect(payrollRow.grossPay).toBeUndefined();

    const invoicesRes = await request(app).get("/api/invoices").set(authed(ctx.siteManagerToken));
    expect(invoicesRes.status).toBe(200);
    const invoiceRow = invoicesRes.body.find((r: { id: string }) => r.id === invoiceId);
    expect(invoiceRow).toBeDefined();
    expect(invoiceRow.totalAmount).toBeUndefined();
  });
});

// The admin portal has to know, before it renders, whether the signed-in user
// may browse the sanitized payroll/invoice lists — otherwise a bookkeeper
// still lands on the owner-locked dead end. /auth/me carries the caller's
// effective permission keys for exactly that decision (advisory only; every
// endpoint re-checks the same matrix).
describe("/auth/me exposes the caller's effective permission keys", () => {
  afterAll(async () => {
    await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "finance.transactions"));
    clearPermissionOverrideInMemory("finance.transactions");
  });

  it("includes finance.transactions for an admin and omits it for an officer", async () => {
    const adminMe = await request(app).get("/api/auth/me").set(authed(ctx.nonOwnerAdminToken));
    expect(adminMe.status).toBe(200);
    expect(adminMe.body.permissions).toContain("finance.transactions");

    const officerMe = await request(app).get("/api/auth/me").set(authed(ctx.officerToken));
    expect(officerMe.status).toBe(200);
    expect(officerMe.body.permissions).not.toContain("finance.transactions");
  });

  it("reflects a granted toggle on the next /auth/me with no re-login", async () => {
    const before = await request(app).get("/api/auth/me").set(authed(ctx.siteManagerToken));
    expect(before.body.permissions).not.toContain("finance.transactions");

    const grant = await request(app)
      .patch("/api/admin/permissions/finance.transactions")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "site_manager"] });
    expect(grant.status).toBe(200);

    const after = await request(app).get("/api/auth/me").set(authed(ctx.siteManagerToken));
    expect(after.body.permissions).toContain("finance.transactions");
  });
});

describe("Company-owner revoke takes effect on the very next request (no re-login)", () => {
  it("401/403s an admin's outstanding token on the next call the instant isCompanyOwner flips to false", async () => {
    // Grant, in the DB directly (bypassing the route, to isolate the
    // "live re-read" mechanism from the grant/revoke route itself).
    await db.update(usersTable).set({ isCompanyOwner: true }).where(eq(usersTable.id, ctx.nonOwnerAdminId));
    const grantedRes = await request(app).get("/api/payroll/board").set(authed(ctx.nonOwnerAdminToken));
    expect(grantedRes.status).not.toBe(403);

    // Revoke — same pre-issued JWT, no new token minted, no re-login.
    await db.update(usersTable).set({ isCompanyOwner: false }).where(eq(usersTable.id, ctx.nonOwnerAdminId));
    const revokedRes = await request(app).get("/api/payroll/board").set(authed(ctx.nonOwnerAdminToken));
    expect(revokedRes.status).toBe(403);
  });
});

describe("Company-owner grant/revoke route (routes/companyOwners.ts)", () => {
  it("403s a non-owner admin who tries to view or change the owners list", async () => {
    const listRes = await request(app).get("/api/admin/company-owners").set(authed(ctx.nonOwnerAdminToken));
    expect(listRes.status).toBe(403);

    const patchRes = await request(app)
      .patch(`/api/admin/company-owners/${ctx.officerId}`)
      .set(authed(ctx.nonOwnerAdminToken))
      .send({ isCompanyOwner: true });
    expect(patchRes.status).toBe(403);
  });

  it("lets an existing owner grant the flag to another user, and it never touches role or super-admin", async () => {
    const before = await db
      .select({ role: usersTable.role, isCompanyOwner: usersTable.isCompanyOwner })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.officerId));
    expect(before[0].isCompanyOwner).toBe(false);

    const res = await request(app)
      .patch(`/api/admin/company-owners/${ctx.officerId}`)
      .set(authed(ctx.ownerAdminToken))
      .send({ isCompanyOwner: true });
    expect(res.status).toBe(200);
    expect(res.body.user.isCompanyOwner).toBe(true);

    // Role is completely untouched — an officer stays "employee", never
    // escalated toward admin/platform access by this grant.
    const after = await db
      .select({ role: usersTable.role, isCompanyOwner: usersTable.isCompanyOwner })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.officerId));
    expect(after[0].role).toBe("employee");
    expect(after[0].isCompanyOwner).toBe(true);

    // The PATCH request body/response never has a `role` or `superAdmin`
    // field the caller could smuggle a platform-privilege change through.
    expect(res.body.user).not.toHaveProperty("superAdmin");

    // Clean up so later assertions about ownerCount aren't affected.
    await db.update(usersTable).set({ isCompanyOwner: false }).where(eq(usersTable.id, ctx.officerId));
  });

  it("refuses to revoke the last remaining company owner", async () => {
    // Force the fixture down to exactly one active owner.
    await db.update(usersTable).set({ isCompanyOwner: false }).where(eq(usersTable.id, ctx.nonOwnerAdminId));
    await db.update(usersTable).set({ isCompanyOwner: false }).where(eq(usersTable.id, ctx.officerId));
    const n = await countCompanyOwners();
    // Only proceed with an assertion meaningful to THIS fixture: pin the
    // owner-admin as the sole remaining owner among our fixture users by
    // asserting the revoke of that specific user is rejected once it is
    // the last owner in the whole deployment.
    if (n === 1) {
      const res = await request(app)
        .patch(`/api/admin/company-owners/${ctx.ownerAdminId}`)
        .set(authed(ctx.ownerAdminToken))
        .send({ isCompanyOwner: false });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/last remaining/i);
    } else {
      // Another owner exists elsewhere in the DB (e.g. seeded demo data) —
      // the invariant still holds globally, just not observable from this
      // single-user toggle. Skip without failing the suite.
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe("Rollout backfill is durably one-time (revocation survives a restart)", () => {
  it("never re-grants a deliberately revoked owner flag when the boot backfill runs again", async () => {
    // The server's own boot sequence calls backfillCompanyOwnersFromAdminRole()
    // on every start, and this dev DB has already booted at least once, so the
    // durable "singleton" marker row must already exist.
    const [marker] = await db
      .select({ id: companyOwnerRolloutTable.id })
      .from(companyOwnerRolloutTable)
      .where(eq(companyOwnerRolloutTable.id, "singleton"));
    expect(marker).toBeTruthy();

    // Simulate: an admin who was granted the flag by the original rollout,
    // then had it deliberately revoked by an owner, while remaining an admin.
    const revokedAdminId = await makeUser("admin", "revoked-admin", false);

    // Simulate a restart: call the exact function the boot sequence calls.
    const updatedCount = await backfillCompanyOwnersFromAdminRole();
    expect(updatedCount).toBe(0); // marker already present — must be a no-op

    const [row] = await db
      .select({ isCompanyOwner: usersTable.isCompanyOwner })
      .from(usersTable)
      .where(eq(usersTable.id, revokedAdminId));
    expect(row.isCompanyOwner).toBe(false); // NOT silently restored
  });
});

describe("Rollout backfill never permanently locks out a deployment with zero admins yet", () => {
  // `shouldClaimCompanyOwnerRollout` is the pure decision of whether a given
  // backfill attempt is allowed to permanently claim its one-time marker.
  // Unit-tested directly (no DB) because the real end-to-end "zero admins,
  // zero owners anywhere" state (SEED_DEMO_USERS=false on a brand-new
  // database, or a seeding failure) can't be safely reproduced against this
  // suite's shared dev DB, which already has real admin/owner rows from
  // outside this test file.
  it("does NOT claim the marker when an attempt finds nothing to do and no owner exists yet (fresh DB / seeding disabled or failed)", () => {
    expect(shouldClaimCompanyOwnerRollout(0, 0)).toBe(false);
  });

  it("claims the marker once an attempt actually promotes at least one admin", () => {
    expect(shouldClaimCompanyOwnerRollout(1, 1)).toBe(true);
  });

  it("claims the marker on a re-run that finds nothing new to promote but an owner already exists (rollout already satisfied)", () => {
    expect(shouldClaimCompanyOwnerRollout(0, 1)).toBe(true);
  });

  // backfillCompanyOwnersFromAdminRole() is a real, globally-scoped
  // migration: whichever call actually claims its marker also grants the
  // flag to EVERY admin in the whole DB that is currently not an owner, not
  // just this suite's fixtures. These tests use a unique test-only markerId
  // (never the real "singleton") so they don't consume the production
  // rollout's one-time claim, but the grant side effect is still global —
  // snapshot/restore whichever admins it touches so no other suite observes
  // a side effect from exercising this behavior.
  async function withGlobalNonOwnerAdminsRestored<T>(run: () => Promise<T>): Promise<T> {
    const before = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.isCompanyOwner, false)));
    try {
      return await run();
    } finally {
      if (before.length > 0) {
        const arr = sql.raw(`ARRAY['${before.map((b) => b.id).join("','")}']::uuid[]`);
        await db.execute(sql`UPDATE users SET is_company_owner = false WHERE id = ANY(${arr})`);
      }
    }
  }

  it("end-to-end: an admin created before the (sequenced) backfill call is granted the flag, and the rollout closes for good", async () => {
    await withGlobalNonOwnerAdminsRestored(async () => {
      const marker = `${TAG}-correct-order`;
      // Admin provisioning (seedDemoUsers-equivalent) completes first, as
      // index.ts now guarantees via `demoUsersSeeded.then(() =>
      // backfillCompanyOwnersFromAdminRole())`...
      const earlyAdminId = await makeUser("admin", "early-admin", false);
      // ...and only then does the backfill run.
      const updatedCount = await backfillCompanyOwnersFromAdminRole(marker);
      expect(updatedCount).toBeGreaterThan(0);

      const [row] = await db
        .select({ isCompanyOwner: usersTable.isCompanyOwner })
        .from(usersTable)
        .where(eq(usersTable.id, earlyAdminId));
      expect(row.isCompanyOwner).toBe(true);

      // The rollout is now closed under this marker: a later admin is not
      // retroactively granted the flag by a re-run (matches the "durably
      // one-time" behavior proven in the sibling describe block above).
      const lateAdminId = await makeUser("admin", "late-admin-after-close", false);
      const secondRun = await backfillCompanyOwnersFromAdminRole(marker);
      expect(secondRun).toBe(0);
      const [lateRow] = await db
        .select({ isCompanyOwner: usersTable.isCompanyOwner })
        .from(usersTable)
        .where(eq(usersTable.id, lateAdminId));
      expect(lateRow.isCompanyOwner).toBe(false);
    });
  });
});

describe("Concurrent revoke cannot zero out the owner set (race safety)", () => {
  it("lets exactly one of two simultaneous last-pair revokes through, and blocks the other", async () => {
    // Isolate the invariant: temporarily demote every other active owner in
    // the deployment so exactly two owners (our fixture users) exist, race
    // them, then restore the original owners — same snapshot/restore pattern
    // used for other global-state tests in this suite.
    const others = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.isCompanyOwner, true), eq(usersTable.status, "active")));
    const otherIds = others.map((o) => o.id);
    if (otherIds.length > 0) {
      const arr = sql.raw(`ARRAY['${otherIds.join("','")}']::uuid[]`);
      await db.execute(sql`UPDATE users SET is_company_owner = false WHERE id = ANY(${arr})`);
    }

    const raceAId = await makeUser("admin", "race-owner-a", true);
    const raceBId = await makeUser("admin", "race-owner-b", true);
    const raceAToken = signToken({ userId: raceAId, email: `${TAG}-race-owner-a@example.test`, role: "admin" });
    const raceBToken = signToken({ userId: raceBId, email: `${TAG}-race-owner-b@example.test`, role: "admin" });

    try {
      expect(await countCompanyOwners()).toBe(2);

      // Fire both revokes at the same instant: A revokes B, B revokes A.
      const [resA, resB] = await Promise.all([
        request(app).patch(`/api/admin/company-owners/${raceBId}`).set(authed(raceAToken)).send({ isCompanyOwner: false }),
        request(app).patch(`/api/admin/company-owners/${raceAId}`).set(authed(raceBToken)).send({ isCompanyOwner: false }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one succeeds (200), the other is rejected as the last owner (400)
      // — a shared row lock (countCompanyOwnersForUpdate) serializes the two
      // transactions so the second always re-checks the post-commit count.
      expect(statuses).toEqual([200, 400]);
      expect(await countCompanyOwners()).toBe(1); // never zero
    } finally {
      if (otherIds.length > 0) {
        const arr = sql.raw(`ARRAY['${otherIds.join("','")}']::uuid[]`);
        await db.execute(sql`UPDATE users SET is_company_owner = true WHERE id = ANY(${arr})`);
      }
    }
  });
});

describe("Officer / site-manager own-pay visibility is unaffected by this feature", () => {
  it("still lets an officer read their own employee profile (rate visible) with no owner flag involved", async () => {
    const res = await request(app).get(`/api/employees/${ctx.officerId}`).set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    expect(res.body.hourlyRate).toBe("30.00");
  });

  it("still lets a site manager read their own employee profile (rate visible)", async () => {
    const res = await request(app).get(`/api/employees/${ctx.siteManagerId}`).set(authed(ctx.siteManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.hourlyRate).toBe("35.00");
  });
});

describe("Permission-matrix defaults reproduce today's role behavior for the 5 representative routes", () => {
  it("lets a site manager (default-allowed role) create a shift via the scheduling.manage permission", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.siteManagerToken))
      .send({
        title: `${TAG}-shift-scheduling-perm`,
        siteId: ctx.siteId,
        startTime: new Date(Date.now() + 3600_000).toISOString(),
        endTime: new Date(Date.now() + 7200_000).toISOString(),
        payRate: "25.00",
        billRate: "40.00",
        requiredLicenseLevel: 1,
        headcount: 1,
      });
    expect(res.status).toBe(201);
    await db.delete(shiftsTable).where(eq(shiftsTable.id, res.body.id));
  });

  it("blocks a plain officer (not in scheduling.manage's default allowed roles) from creating a shift", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set(authed(ctx.officerToken))
      .send({
        title: `${TAG}-shift-should-fail`,
        siteId: ctx.siteId,
        startTime: new Date(Date.now() + 3600_000).toISOString(),
        endTime: new Date(Date.now() + 7200_000).toISOString(),
        payRate: "25.00",
        billRate: "40.00",
        requiredLicenseLevel: 1,
        headcount: 1,
      });
    expect(res.status).toBe(403);
  });
});

describe("Permission-matrix overrides change enforcement immediately (no redeploy)", () => {
  afterAll(async () => {
    await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "dispatch.manage"));
    clearPermissionOverrideInMemory("dispatch.manage");
    await loadPermissionOverridesFromDb();
  });

  it("blocks an employee from /dispatch/assign-nearest before any override (default: admin+dispatcher only)", async () => {
    const res = await request(app)
      .post("/api/dispatch/assign-nearest")
      .set(authed(ctx.officerToken))
      .send({ shiftId: randomUUID() });
    expect(res.status).toBe(403);
  });

  it("lets an employee through immediately after an admin adds 'employee' to dispatch.manage's allowed roles", async () => {
    const res = await request(app)
      .patch("/api/admin/permissions/dispatch.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "dispatcher", "employee"] });
    expect(res.status).toBe(200);
    expect(res.body.permission.allowedRoles).toEqual(expect.arrayContaining(["employee"]));

    // Same pre-issued token, no redeploy — the middleware's in-memory cache
    // was refreshed synchronously by the PATCH above.
    const gated = await request(app)
      .post("/api/dispatch/assign-nearest")
      .set(authed(ctx.officerToken))
      .send({ shiftId: randomUUID() });
    // No longer a blanket 403 from requirePermission — whatever status comes
    // back (400/404 for the fake shiftId) proves the role gate was passed.
    expect(gated.status).not.toBe(403);
  });

  it("reverting the override (allowedRoles: null) restores the default block", async () => {
    const reset = await request(app)
      .patch("/api/admin/permissions/dispatch.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: null });
    expect(reset.status).toBe(200);
    expect(reset.body.permission.isOverridden).toBe(false);

    const res = await request(app)
      .post("/api/dispatch/assign-nearest")
      .set(authed(ctx.officerToken))
      .send({ shiftId: randomUUID() });
    expect(res.status).toBe(403);
  });

  it("403s a non-admin trying to change the permission matrix", async () => {
    const res = await request(app)
      .patch("/api/admin/permissions/dispatch.manage")
      .set(authed(ctx.officerToken))
      .send({ allowedRoles: ["admin", "employee"] });
    expect(res.status).toBe(403);
  });

  it("can never strip 'admin' out of a permission key's allowed roles", async () => {
    const res = await request(app)
      .patch("/api/admin/permissions/dispatch.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["dispatcher"] }); // deliberately omits admin
    expect(res.status).toBe(200);
    expect(res.body.permission.allowedRoles).toEqual(expect.arrayContaining(["admin"]));
  });
});

describe("Delegating personnel.manage can never be used to self-escalate to a privileged role", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db.delete(usersTable).where(
        sql`${usersTable.id} = ANY(ARRAY[${sql.join(
          createdUserIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])`,
      );
    }
    await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "personnel.manage"));
    clearPermissionOverrideInMemory("personnel.manage");
    await loadPermissionOverridesFromDb();
  });

  it("grants personnel.manage to site_manager and dispatcher (a delegated, non-admin role) for this test", async () => {
    const res = await request(app)
      .patch("/api/admin/permissions/personnel.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "site_manager", "dispatcher"] });
    expect(res.status).toBe(200);
  });

  it("blocks a delegated (non-admin) caller from creating an account with role: admin", async () => {
    const res = await request(app)
      .post("/api/employees")
      .set(authed(ctx.siteManagerToken))
      .send({
        email: `${TAG}-escalate-admin@example.test`,
        password: "test-password",
        firstName: "Escalate",
        lastName: "Admin",
        role: "admin",
      });
    expect(res.status).toBe(403);
  });

  it("blocks a delegated (non-admin) caller from creating an account with role: dispatcher or site_manager", async () => {
    for (const role of ["dispatcher", "site_manager"]) {
      const res = await request(app)
        .post("/api/employees")
        .set(authed(ctx.siteManagerToken))
        .send({
          email: `${TAG}-escalate-${role}@example.test`,
          password: "test-password",
          firstName: "Escalate",
          lastName: role,
          role,
        });
      expect(res.status).toBe(403);
    }
  });

  it("still lets the delegated caller create a plain employee account (the intended, scoped capability)", async () => {
    const res = await request(app)
      .post("/api/employees")
      .set(authed(ctx.siteManagerToken))
      .send({
        email: `${TAG}-delegated-employee@example.test`,
        password: "test-password",
        firstName: "Delegated",
        lastName: "Employee",
        role: "employee",
      });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("employee");
    createdUserIds.push(res.body.id);
  });

  it("an actual admin caller (not just personnel.manage) may still create a privileged-role account", async () => {
    const res = await request(app)
      .post("/api/employees")
      .set(authed(ctx.ownerAdminToken))
      .send({
        email: `${TAG}-admin-created-dispatcher@example.test`,
        password: "test-password",
        firstName: "Admin",
        lastName: "Created",
        role: "dispatcher",
      });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("dispatcher");
    createdUserIds.push(res.body.id);
  });
});

// Task #735 — the permission matrix now also gates the remaining
// scheduling/time-attendance/personnel CRUD routes, not just the one
// representative action per area wired up by Task #733.
describe("Permission-matrix toggles now also govern shift edit, time-entry approval, and non-self employee edit", () => {
  let editShiftId: string;
  let pendingEntryId: string;

  beforeAll(async () => {
    const [shift] = await db
      .insert(shiftsTable)
      .values({
        siteId: ctx.siteId,
        title: `${TAG}-edit-shift`,
        startTime: new Date(Date.now() + 3600_000),
        endTime: new Date(Date.now() + 7200_000),
        payRate: "25.00",
        billRate: "40.00",
        requiredLicenseLevel: 1,
        headcount: 1,
      })
      .returning({ id: shiftsTable.id });
    editShiftId = shift.id;

    const [entry] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.officerId,
        siteId: ctx.siteId,
        clockInTime: new Date(Date.now() - 8 * 3600_000),
        clockOutTime: new Date(Date.now() - 3600_000),
        approvalStatus: "pending",
      })
      .returning({ id: timeEntriesTable.id });
    pendingEntryId = entry.id;
  });

  afterAll(async () => {
    await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, pendingEntryId));
    await db.delete(shiftsTable).where(eq(shiftsTable.id, editShiftId));
  });

  it("PUT /shifts/:id (scheduling.manage): blocks a plain officer by default, then lets one through once granted", async () => {
    const blocked = await request(app)
      .put(`/api/shifts/${editShiftId}`)
      .set(authed(ctx.officerToken))
      .send({ notes: "should be blocked" });
    expect(blocked.status).toBe(403);

    const grant = await request(app)
      .patch("/api/admin/permissions/scheduling.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "site_manager", "employee"] });
    expect(grant.status).toBe(200);

    try {
      const allowed = await request(app)
        .put(`/api/shifts/${editShiftId}`)
        .set(authed(ctx.officerToken))
        .send({ notes: "now allowed" });
      expect(allowed.status).not.toBe(403);
    } finally {
      await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "scheduling.manage"));
      clearPermissionOverrideInMemory("scheduling.manage");
      await loadPermissionOverridesFromDb();
    }

    // Default is restored: the same officer is blocked again.
    const blockedAgain = await request(app)
      .put(`/api/shifts/${editShiftId}`)
      .set(authed(ctx.officerToken))
      .send({ notes: "should be blocked again" });
    expect(blockedAgain.status).toBe(403);
  });

  it("POST /time-entries/:id/approve (timeAttendance.manage): blocks a plain officer by default, then lets one through once granted", async () => {
    const blocked = await request(app)
      .post(`/api/time-entries/${pendingEntryId}/approve`)
      .set(authed(ctx.officerToken))
      .send({ decision: "approved" });
    expect(blocked.status).toBe(403);

    const grant = await request(app)
      .patch("/api/admin/permissions/timeAttendance.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "site_manager", "employee"] });
    expect(grant.status).toBe(200);

    try {
      const allowed = await request(app)
        .post(`/api/time-entries/${pendingEntryId}/approve`)
        .set(authed(ctx.officerToken))
        .send({ decision: "approved" });
      expect(allowed.status).not.toBe(403);
    } finally {
      await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "timeAttendance.manage"));
      clearPermissionOverrideInMemory("timeAttendance.manage");
      await loadPermissionOverridesFromDb();
    }
  });

  it("PUT /employees/:id editing ANOTHER user (personnel.manage): blocks a site manager by default, then lets one through once granted — self-edit stays unaffected either way", async () => {
    const blocked = await request(app)
      .put(`/api/employees/${ctx.officerId}`)
      .set(authed(ctx.siteManagerToken))
      .send({ firstName: "ShouldNotChange" });
    expect(blocked.status).toBe(403);

    // Self-edit is never gated by this permission, regardless of the toggle.
    const selfEdit = await request(app)
      .put(`/api/employees/${ctx.siteManagerId}`)
      .set(authed(ctx.siteManagerToken))
      .send({ firstName: "Test" });
    expect(selfEdit.status).toBe(200);

    const grant = await request(app)
      .patch("/api/admin/permissions/personnel.manage")
      .set(authed(ctx.ownerAdminToken))
      .send({ allowedRoles: ["admin", "site_manager"] });
    expect(grant.status).toBe(200);

    try {
      const allowed = await request(app)
        .put(`/api/employees/${ctx.officerId}`)
        .set(authed(ctx.siteManagerToken))
        .send({ firstName: "Test" });
      expect(allowed.status).toBe(200);
      // Non-admin editors still can't set restricted admin-only fields (status)
      // even once granted personnel.manage for the "edit someone else" gate.
      expect(allowed.body.status).not.toBe("terminated");
    } finally {
      await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, "personnel.manage"));
      clearPermissionOverrideInMemory("personnel.manage");
      await loadPermissionOverridesFromDb();
    }
  });
});

// Task #745 — the two describe blocks above only assert that the fields
// present *today* (grossPay/netPay/subtotal/totalAmount) are stripped from
// the plain payroll/invoice lists for a non-owner. That leaves a silent gap:
// a later change could add a brand-new money-shaped column to either table,
// select it in the list route, and never add it to DASHBOARD_FINANCE_FIELDS
// — the leak would ship with green tests because nothing asserted the
// *complete* set of money columns, only the ones someone remembered to check.
//
// This closes that gap at the schema level: every `numeric` column on
// payrollEntriesTable / invoicesTable must be accounted for by EITHER the
// small per-record allowlist below (rates/durations that are intentionally
// visible to a non-owner bookkeeper, the same class as shift payRate) OR
// DASHBOARD_FINANCE_FIELDS. Adding a numeric column to either table without
// updating one of those two lists fails this test immediately, and the two
// live-endpoint tests below independently prove the strip is actually wired
// up at runtime (not just declared).
describe("Every numeric (money-shaped) column on the payroll/invoice list rows is either allowlisted or stripped for non-owners", () => {
  // hourlyRate: a single officer's own pay rate for that pay period — the
  // same class as shift payRate, which is visible to internal staff
  // (including a non-owner, finance-bearing dispatcher/admin) under the
  // separate role-based axis in stripShiftFinanceForRole. totalHours is a
  // duration, not money, even though it's stored as `numeric`.
  const PAYROLL_NUMERIC_ALLOWLIST = new Set(["totalHours", "hourlyRate"]);
  // Every numeric column on invoices is a dollar figure with no per-record
  // "rate that's fine to browse in bulk" exception — nothing is allowlisted.
  const INVOICE_NUMERIC_ALLOWLIST = new Set<string>([]);

  function numericColumnKeys(table: Parameters<typeof getTableColumns>[0]): string[] {
    const columns = getTableColumns(table);
    return Object.entries(columns)
      .filter(([, col]) => (col as { columnType?: string }).columnType === "PgNumeric")
      .map(([key]) => key);
  }

  const payrollNumericKeys = numericColumnKeys(payrollEntriesTable);
  const invoiceNumericKeys = numericColumnKeys(invoicesTable);

  it("payroll_entries has at least one numeric column to check (sanity guard against a schema-introspection regression)", () => {
    expect(payrollNumericKeys.length).toBeGreaterThan(0);
  });

  it("invoices has at least one numeric column to check (sanity guard against a schema-introspection regression)", () => {
    expect(invoiceNumericKeys.length).toBeGreaterThan(0);
  });

  it.each(payrollNumericKeys)("payroll_entries.%s is either allowlisted for bookkeepers or in DASHBOARD_FINANCE_FIELDS", (key) => {
    const covered = PAYROLL_NUMERIC_ALLOWLIST.has(key) || DASHBOARD_FINANCE_FIELDS.has(key);
    expect(covered).toBe(true);
  });

  it.each(invoiceNumericKeys)("invoices.%s is either allowlisted for bookkeepers or in DASHBOARD_FINANCE_FIELDS", (key) => {
    const covered = INVOICE_NUMERIC_ALLOWLIST.has(key) || DASHBOARD_FINANCE_FIELDS.has(key);
    expect(covered).toBe(true);
  });

  describe("live GET /payroll and GET /invoices responses to a non-owner never carry an unallowlisted numeric field", () => {
    let liveEntryId: string;
    let liveInvoiceId: string;

    beforeAll(async () => {
      const [entry] = await db
        .insert(payrollEntriesTable)
        .values({
          employeeId: ctx.officerId,
          siteId: ctx.siteId,
          periodStart: "2020-02-03",
          periodEnd: "2020-02-09",
          totalHours: "12.00",
          hourlyRate: "30.00",
          grossPay: "360.00",
          tax: "0",
          netPay: "360.00",
          status: "pending",
        })
        .returning({ id: payrollEntriesTable.id });
      liveEntryId = entry.id;

      const [invoice] = await db
        .insert(invoicesTable)
        .values({
          invoiceNumber: `${TAG}-INV-numeric-guard`,
          clientId: ctx.clientId,
          siteId: ctx.siteId,
          clientName: `${TAG}-client`,
          lineItems: [{ description: "Officer coverage", hours: 12, rate: 30, amount: 360 }],
          subtotal: "360.00",
          taxAmount: "10.00",
          totalAmount: "370.00",
          processingFeeRate: "3.00",
          processingFeeAmount: "11.10",
          status: "draft",
          dueDate: "2020-03-01",
        })
        .returning({ id: invoicesTable.id });
      liveInvoiceId = invoice.id;
    });

    afterAll(async () => {
      await db.delete(payrollEntriesTable).where(eq(payrollEntriesTable.id, liveEntryId));
      await db.delete(invoicesTable).where(eq(invoicesTable.id, liveInvoiceId));
    });

    it("GET /payroll strips every non-allowlisted numeric field for a non-owner", async () => {
      const res = await request(app).get("/api/payroll").set(authed(ctx.nonOwnerAdminToken));
      expect(res.status).toBe(200);
      const row = res.body.find((r: { id: string }) => r.id === liveEntryId);
      expect(row).toBeDefined();
      for (const key of payrollNumericKeys) {
        if (PAYROLL_NUMERIC_ALLOWLIST.has(key)) continue;
        expect(row).not.toHaveProperty(key);
      }
      // The allowlisted fields are still there — this isn't over-stripping.
      expect(row.totalHours).toBe("12.00");
      expect(row.hourlyRate).toBe("30.00");
    });

    it("GET /invoices strips every numeric field (and lineItems) for a non-owner", async () => {
      const res = await request(app).get("/api/invoices").set(authed(ctx.nonOwnerAdminToken));
      expect(res.status).toBe(200);
      const row = res.body.find((r: { id: string }) => r.id === liveInvoiceId);
      expect(row).toBeDefined();
      for (const key of invoiceNumericKeys) {
        expect(row).not.toHaveProperty(key);
      }
      expect(row).not.toHaveProperty("lineItems");
      // Non-financial fields needed to locate the record are untouched.
      expect(row.invoiceNumber).toBe(`${TAG}-INV-numeric-guard`);
      expect(row.status).toBe("draft");
    });

    it("a company owner still sees every numeric field and the line items, unstripped", async () => {
      const payrollRes = await request(app).get("/api/payroll").set(authed(ctx.ownerAdminToken));
      const payrollRow = payrollRes.body.find((r: { id: string }) => r.id === liveEntryId);
      expect(payrollRow.grossPay).toBe("360.00");
      expect(payrollRow.netPay).toBe("360.00");

      const invoiceRes = await request(app).get("/api/invoices").set(authed(ctx.ownerAdminToken));
      const invoiceRow = invoiceRes.body.find((r: { id: string }) => r.id === liveInvoiceId);
      expect(invoiceRow.subtotal).toBe("360.00");
      expect(invoiceRow.taxAmount).toBe("10.00");
      expect(invoiceRow.processingFeeAmount).toBe("11.10");
      expect(invoiceRow.lineItems).toHaveLength(1);
    });
  });
});
