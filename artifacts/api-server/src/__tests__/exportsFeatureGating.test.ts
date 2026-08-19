/**
 * Cross-domain feature gating for the Exports center + dashboard aggregates.
 *
 * The dedicated payroll / invoices / incidents / HR routers already 403 when
 * their flag is off (see featureGating.test.ts). But two read paths surface
 * that same data INDIRECTLY:
 *   - the Exports center (its own `exports`-gated router) can export payroll /
 *     incident / application rows, and
 *   - the dashboard summaries (core, ungated) roll up pending payroll and
 *     incident counts.
 * When a deployment disables a feature, those indirect paths must exclude the
 * feature's data too — exports 403s the dataset, dashboard zeroes the roll-up.
 *
 * These routers are mounted directly here (not via the full app) so the guard
 * under test is exercised in isolation, independent of the order routers are
 * registered in routes/index.ts.
 */

import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  incidentsTable,
  payrollEntriesTable,
} from "@workspace/db";
import exportsRouter from "../routes/exports";
import dashboardRouter from "../routes/dashboard";
import { signToken } from "../middlewares/auth";
import { FEATURE_KEYS, setOverrideInMemory, clearOverrideInMemory } from "../lib/features";

const TAG = `exports-gate-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const ctx = {} as {
  adminToken: string;
  employeeId: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
};

// Minimal app mounting just the two routers under test at /api — no global
// requireFeature gate, so the cross-domain guards inside the routers are what
// produce (or withhold) the 403 / zeroed response.
let testApp: Express;

beforeAll(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@example.test`,
      passwordHash,
      firstName: "Admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
      // The payroll_entries export dataset is finance-gated (Task #733).
      isCompanyOwner: true,
    })
    .returning({ id: usersTable.id });
  ctx.adminToken = signToken({ userId: admin.id, email: `${TAG}-admin@example.test`, role: "admin" });

  const [employee] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-emp@example.test`,
      passwordHash,
      firstName: "Emp",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.employeeId = employee.id;
  ctx.employeeToken = signToken({ userId: employee.id, email: `${TAG}-emp@example.test`, role: "employee" });

  const [client] = await db.insert(clientsTable).values({ name: `${TAG}-client` }).returning({ id: clientsTable.id });
  ctx.clientId = client.id;
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: start,
      endTime: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });

  // A non-zero incident + pending payroll entry so the dashboard roll-ups are
  // > 0 when the features are enabled and provably 0 when disabled.
  await db.insert(incidentsTable).values({
    title: `${TAG}-incident`,
    description: "test",
    severity: "critical",
    status: "open",
    employeeId: ctx.employeeId,
    shiftId: shift.id,
    occurredAt: new Date(),
  });
  await db.insert(payrollEntriesTable).values({
    employeeId: ctx.employeeId,
    siteId: ctx.siteId,
    periodStart: new Date().toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
    totalHours: "8",
    hourlyRate: "20",
    grossPay: "160",
    tax: "0",
    netPay: "160",
    status: "pending",
  });

  testApp = express();
  testApp.use(express.json());
  testApp.use("/api", exportsRouter);
  testApp.use("/api", dashboardRouter);
});

afterEach(() => {
  for (const k of FEATURE_KEYS) clearOverrideInMemory(k);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ${ctx.employeeId}`);
  await db.execute(sql`DELETE FROM incidents WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function exportReq(path: string, dataset: string) {
  return request(testApp)
    .post(`/api/admin/exports/${path}`)
    .set("Authorization", `Bearer ${ctx.adminToken}`)
    .send({ dataset, filters: {} });
}

describe("Exports center cross-domain feature gating", () => {
  it("403s the payroll dataset on every output when payroll is off", async () => {
    setOverrideInMemory("payroll", false);
    for (const path of ["preview", "csv", "pdf"]) {
      const res = await exportReq(path, "payroll_entries");
      expect(res.status, `${path} payroll_entries`).toBe(403);
      expect(res.body?.error).toBe("Forbidden");
      expect(res.body?.feature).toBe("payroll");
    }
  });

  it("403s the incidents dataset when incidents is off", async () => {
    setOverrideInMemory("incidents", false);
    const res = await exportReq("preview", "incidents");
    expect(res.status).toBe(403);
    expect(res.body?.feature).toBe("incidents");
  });

  it("403s the applications dataset when hr is off", async () => {
    setOverrideInMemory("hr", false);
    const res = await exportReq("preview", "applications");
    expect(res.status).toBe(403);
    expect(res.body?.feature).toBe("hr");
  });

  it("still serves the payroll dataset when payroll is enabled", async () => {
    const res = await exportReq("preview", "payroll_entries");
    expect(res.status).toBe(200);
    expect(res.body?.dataset).toBe("payroll_entries");
  });

  it("keeps core datasets exportable even when payroll+incidents+hr are off", async () => {
    setOverrideInMemory("payroll", false);
    setOverrideInMemory("incidents", false);
    setOverrideInMemory("hr", false);
    for (const dataset of ["shifts", "time_entries", "officers"]) {
      const res = await exportReq("preview", dataset);
      expect(res.status, dataset).toBe(200);
      expect(res.body?.dataset).toBe(dataset);
    }
  });
});

describe("Dashboard aggregates omit disabled-feature data", () => {
  function adminSummary() {
    return request(testApp)
      .get("/api/dashboard/admin-summary")
      .set("Authorization", `Bearer ${ctx.adminToken}`);
  }
  function employeeSummary() {
    return request(testApp)
      .get("/api/dashboard/employee-summary")
      .set("Authorization", `Bearer ${ctx.employeeToken}`);
  }

  it("surfaces payroll + incident roll-ups when those features are enabled", async () => {
    const res = await adminSummary();
    expect(res.status).toBe(200);
    expect(res.body.pendingPayroll).toBeGreaterThanOrEqual(1);
    expect(res.body.openIncidents).toBeGreaterThanOrEqual(1);
    expect(res.body.criticalIncidents).toBeGreaterThanOrEqual(1);
    expect(res.body.recentIncidents.length).toBeGreaterThanOrEqual(1);
  });

  it("zeroes payroll + incidents in the admin summary when those features are off", async () => {
    setOverrideInMemory("payroll", false);
    setOverrideInMemory("incidents", false);
    const res = await adminSummary();
    expect(res.status).toBe(200);
    expect(res.body.pendingPayroll).toBe(0);
    expect(res.body.openIncidents).toBe(0);
    expect(res.body.criticalIncidents).toBe(0);
    expect(res.body.recentIncidents).toEqual([]);
  });

  it("zeroes myOpenIncidents in the employee summary when incidents is off", async () => {
    const on = await employeeSummary();
    expect(on.status).toBe(200);
    expect(on.body.myOpenIncidents).toBeGreaterThanOrEqual(1);

    setOverrideInMemory("incidents", false);
    const off = await employeeSummary();
    expect(off.status).toBe(200);
    expect(off.body.myOpenIncidents).toBe(0);
  });
});
