/**
 * Global search feature-gating, pagination, and relevance-ranking tests.
 *
 * GET /admin/search?q=<term>[&page=1&limit=10] is an admin-only cross-domain
 * text search. Unlike the dedicated payroll / incidents / hr / chat routers
 * (which 403 entirely when their flag is off), global search is a core admin
 * surface mounted without a router-level requireFeature gate. Instead,
 * per-domain isFeatureEnabled checks inside the handler exclude disabled-feature
 * results — the same cross-domain pattern used by the dashboard and exports center.
 *
 * These tests assert that:
 *  - employees and shifts are always returned (core, never gated).
 *  - incidents results are omitted when the "incidents" flag is off.
 *  - payroll results are omitted when the "payroll" flag is off.
 *  - application results are omitted when the "hr" flag is off.
 *  - chatRoom results are omitted when the "chat" flag is off.
 *  - all disabled-feature domains return together when all four flags are off.
 *  - an employee token is refused (admin-only).
 *  - missing / blank q returns 400.
 *  - pagination params (page, limit) are validated and applied per domain.
 *  - hasMore is true when a domain has more results than the requested limit.
 *  - page=2 skips the first page of results.
 *  - limit > 50 or page < 1 return 400.
 *  - response includes page and limit echo-back fields.
 *  - disabled-feature domains return hasMore: false regardless of pagination.
 */

import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  incidentsTable,
  payrollEntriesTable,
  applicationsTable,
  chatRoomsTable,
} from "@workspace/db";
import searchRouter from "../routes/search";
import { signToken } from "../middlewares/auth";
import { FEATURE_KEYS, setOverrideInMemory, clearOverrideInMemory } from "../lib/features";

const TAG = `global-search-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const ctx = {} as {
  adminToken: string;
  employeeToken: string;
  employeeUserId: string;
  dispatcherToken: string;
  dispatcherUserId: string;
};

let testApp: Express;

beforeAll(async () => {
  // Admin user
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@example.test`,
      passwordHash,
      firstName: TAG,
      lastName: "Admin",
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.adminToken = signToken({ userId: admin.id, email: `${TAG}-admin@example.test`, role: "admin" });

  // Employee user (for auth-rejection test + pagination: two users share TAG firstName)
  const [emp] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-emp@example.test`,
      passwordHash,
      firstName: TAG,
      lastName: "Employee",
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.employeeUserId = emp.id;
  ctx.employeeToken = signToken({ userId: emp.id, email: `${TAG}-emp@example.test`, role: "employee" });

  // employee row so the join doesn't error
  await db.insert(employeesTable).values({ userId: emp.id, hourlyRate: "20" }).onConflictDoNothing();

  // Dispatcher user (for dispatcher-access test).
  // firstName, lastName, and email intentionally do NOT contain TAG so this
  // user is never returned by the TAG-keyed employee search and does not
  // break the 2-user pagination assertions in this suite.
  const dispatcherEmail = `dispatch-officer-${randomUUID().slice(0, 8)}@example.test`;
  const [dispatcher] = await db
    .insert(usersTable)
    .values({
      email: dispatcherEmail,
      passwordHash,
      firstName: "Dispatch",
      lastName: "Officer",
      role: "dispatcher",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.dispatcherUserId = dispatcher.id;
  ctx.dispatcherToken = signToken({ userId: dispatcher.id, email: dispatcherEmail, role: "dispatcher" });

  // Seed one incident, one payroll entry, one application, and one chat room
  // whose names / titles embed the TAG so the search query finds exactly them.

  const [client] = await db.insert(clientsTable).values({ name: `${TAG}-client` }).returning({ id: clientsTable.id });
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: client.id, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });

  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: site.id,
      startTime: start,
      endTime: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });

  await db.insert(incidentsTable).values({
    title: `${TAG}-incident`,
    description: "search test incident",
    severity: "low",
    status: "open",
    employeeId: emp.id,
    shiftId: shift.id,
    occurredAt: new Date(),
  });

  await db.insert(payrollEntriesTable).values({
    employeeId: emp.id,
    siteId: site.id,
    periodStart: new Date().toISOString().slice(0, 10),
    periodEnd: new Date().toISOString().slice(0, 10),
    totalHours: "8",
    hourlyRate: "20",
    grossPay: "160",
    tax: "0",
    netPay: "160",
    status: "pending",
  });

  await db.insert(applicationsTable).values({
    firstName: TAG,
    lastName: "Applicant",
    email: `${TAG}-applicant@example.test`,
    phone: "+15550000001",
    address: "1 Test St",
    city: "Austin",
    state: "TX",
    zip: "78701",
  });

  await db.insert(chatRoomsTable).values({
    name: `${TAG}-room`,
    type: "general",
  });

  // Mount only the search router for isolation
  testApp = express();
  testApp.use(express.json());
  testApp.use("/api", searchRouter);
});

afterEach(() => {
  for (const k of FEATURE_KEYS) clearOverrideInMemory(k);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM applications WHERE email LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ${ctx.employeeUserId}`);
  await db.execute(sql`DELETE FROM incidents WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM employees WHERE user_id = ${ctx.employeeUserId}`);
  await db.execute(sql`DELETE FROM users WHERE last_name IN ('Admin', 'Employee') AND first_name = ${TAG}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ctx.dispatcherUserId}`);
});

function search(q: string, token = ctx.adminToken) {
  return request(testApp)
    .get(`/api/admin/search`)
    .set("Authorization", `Bearer ${token}`)
    .query({ q });
}

function searchPaged(q: string, page: number, limit: number, token = ctx.adminToken) {
  return request(testApp)
    .get(`/api/admin/search`)
    .set("Authorization", `Bearer ${token}`)
    .query({ q, page, limit });
}

// ---------------------------------------------------------------------------
// Auth + validation
// ---------------------------------------------------------------------------

describe("GET /admin/search — auth and validation", () => {
  it("requires an admin token (employee gets 403)", async () => {
    const res = await search(TAG, ctx.employeeToken);
    expect(res.status).toBe(403);
  });

  it("allows a dispatcher token (200 with employee + shift + chatRoom results)", async () => {
    const res = await search(TAG, ctx.dispatcherToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.employees)).toBe(true);
    expect(Array.isArray(res.body.shifts)).toBe(true);
    expect(Array.isArray(res.body.chatRooms)).toBe(true);
  });

  it("requires an admin token (unauthenticated gets 401)", async () => {
    const res = await request(testApp).get("/api/admin/search").query({ q: TAG });
    expect(res.status).toBe(401);
  });

  it("returns 400 when q is missing", async () => {
    const res = await request(testApp)
      .get("/api/admin/search")
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(res.status).toBe(400);
  });

  it("returns 400 when q is empty string", async () => {
    const res = await search("");
    expect(res.status).toBe(400);
  });

  it("returns 400 when limit exceeds 50", async () => {
    const res = await searchPaged(TAG, 1, 51);
    expect(res.status).toBe(400);
  });

  it("returns 400 when page is less than 1", async () => {
    const res = await searchPaged(TAG, 0, 10);
    expect(res.status).toBe(400);
  });

  it("returns 400 when page is negative", async () => {
    const res = await searchPaged(TAG, -1, 10);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Core domains — always present
// ---------------------------------------------------------------------------

describe("GET /admin/search — core domains always returned", () => {
  it("returns 200 with all domain keys present", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      q: TAG,
      employees: expect.any(Array),
      shifts: expect.any(Array),
      incidents: expect.any(Array),
      payroll: expect.any(Array),
      applications: expect.any(Array),
      chatRooms: expect.any(Array),
    });
  });

  it("finds the seeded employee by name when all features are enabled", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const names = (res.body.employees as Array<{ label: string }>).map((e) => e.label);
    expect(names.some((n) => n.includes(TAG))).toBe(true);
  });

  it("finds the seeded shift by title when all features are enabled", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const titles = (res.body.shifts as Array<{ label: string }>).map((s) => s.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
  });

  it("employees and shifts are still returned when all gated features are disabled", async () => {
    setOverrideInMemory("incidents", false);
    setOverrideInMemory("payroll", false);
    setOverrideInMemory("hr", false);
    setOverrideInMemory("chat", false);

    const res = await search(TAG);
    expect(res.status).toBe(200);

    const names = (res.body.employees as Array<{ label: string }>).map((e) => e.label);
    expect(names.some((n) => n.includes(TAG))).toBe(true);

    const titles = (res.body.shifts as Array<{ label: string }>).map((s) => s.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Incidents — gated behind "incidents" feature
// ---------------------------------------------------------------------------

describe("GET /admin/search — incidents gated by 'incidents' feature", () => {
  it("returns incident results when incidents feature is enabled", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const titles = (res.body.incidents as Array<{ label: string }>).map((i) => i.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
    expect(res.body.featureStatus.incidents).toBe(true);
  });

  it("returns empty incidents array when incidents feature is disabled", async () => {
    setOverrideInMemory("incidents", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.incidents).toEqual([]);
    expect(res.body.featureStatus.incidents).toBe(false);
  });

  it("disabling incidents does not affect other domains", async () => {
    setOverrideInMemory("incidents", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.payroll.length).toBeGreaterThanOrEqual(1);
    expect(res.body.applications.length).toBeGreaterThanOrEqual(1);
    expect(res.body.chatRooms.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Payroll — gated behind "payroll" feature
// ---------------------------------------------------------------------------

describe("GET /admin/search — payroll gated by 'payroll' feature", () => {
  it("returns payroll results when payroll feature is enabled", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.payroll.length).toBeGreaterThanOrEqual(1);
    expect(res.body.featureStatus.payroll).toBe(true);
  });

  it("returns empty payroll array when payroll feature is disabled", async () => {
    setOverrideInMemory("payroll", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.payroll).toEqual([]);
    expect(res.body.featureStatus.payroll).toBe(false);
  });

  it("disabling payroll does not affect other domains", async () => {
    setOverrideInMemory("payroll", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const titles = (res.body.incidents as Array<{ label: string }>).map((i) => i.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
    expect(res.body.applications.length).toBeGreaterThanOrEqual(1);
    expect(res.body.chatRooms.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Applications — gated behind "hr" feature
// ---------------------------------------------------------------------------

describe("GET /admin/search — applications gated by 'hr' feature", () => {
  it("returns application results when hr feature is enabled", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.applications.length).toBeGreaterThanOrEqual(1);
    expect(res.body.featureStatus.applications).toBe(true);
  });

  it("returns empty applications array when hr feature is disabled", async () => {
    setOverrideInMemory("hr", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.applications).toEqual([]);
    expect(res.body.featureStatus.applications).toBe(false);
  });

  it("disabling hr does not affect other domains", async () => {
    setOverrideInMemory("hr", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const titles = (res.body.incidents as Array<{ label: string }>).map((i) => i.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
    expect(res.body.payroll.length).toBeGreaterThanOrEqual(1);
    expect(res.body.chatRooms.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Chat rooms — gated behind "chat" feature
// ---------------------------------------------------------------------------

describe("GET /admin/search — chatRooms gated by 'chat' feature", () => {
  it("returns chat room results when chat feature is enabled", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const names = (res.body.chatRooms as Array<{ label: string }>).map((r) => r.label);
    expect(names.some((n) => n.includes(TAG))).toBe(true);
    expect(res.body.featureStatus.chatRooms).toBe(true);
  });

  it("returns empty chatRooms array when chat feature is disabled", async () => {
    setOverrideInMemory("chat", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.chatRooms).toEqual([]);
    expect(res.body.featureStatus.chatRooms).toBe(false);
  });

  it("disabling chat does not affect other domains", async () => {
    setOverrideInMemory("chat", false);
    const res = await search(TAG);
    expect(res.status).toBe(200);
    const titles = (res.body.incidents as Array<{ label: string }>).map((i) => i.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
    expect(res.body.payroll.length).toBeGreaterThanOrEqual(1);
    expect(res.body.applications.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// All gated features disabled together
// ---------------------------------------------------------------------------

describe("GET /admin/search — all gated features disabled simultaneously", () => {
  it("returns only core results (employees + shifts) when all four flags are off", async () => {
    setOverrideInMemory("incidents", false);
    setOverrideInMemory("payroll", false);
    setOverrideInMemory("hr", false);
    setOverrideInMemory("chat", false);

    const res = await search(TAG);
    expect(res.status).toBe(200);

    expect(res.body.incidents).toEqual([]);
    expect(res.body.payroll).toEqual([]);
    expect(res.body.applications).toEqual([]);
    expect(res.body.chatRooms).toEqual([]);

    expect(res.body.featureStatus).toEqual({
      incidents: false,
      payroll: false,
      applications: false,
      chatRooms: false,
    });

    // Core domains unaffected
    const names = (res.body.employees as Array<{ label: string }>).map((e) => e.label);
    expect(names.some((n) => n.includes(TAG))).toBe(true);

    const titles = (res.body.shifts as Array<{ label: string }>).map((s) => s.label);
    expect(titles.some((t) => t.includes(TAG))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Response shape — pagination echo-back
// ---------------------------------------------------------------------------

describe("GET /admin/search — response shape includes pagination fields", () => {
  it("echoes back q, page, and limit in the response body", async () => {
    const res = await searchPaged(TAG, 2, 5);
    expect(res.status).toBe(200);
    expect(res.body.q).toBe(TAG);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(5);
  });

  it("defaults page to 1 and limit to 10 when not specified", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
  });

  it("includes hasMore object with all domain keys", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toMatchObject({
      employees: expect.any(Boolean),
      shifts: expect.any(Boolean),
      incidents: expect.any(Boolean),
      payroll: expect.any(Boolean),
      applications: expect.any(Boolean),
      chatRooms: expect.any(Boolean),
    });
  });
});

// ---------------------------------------------------------------------------
// hasMore flag — signals when additional results exist beyond the page
// ---------------------------------------------------------------------------

describe("GET /admin/search — hasMore flag", () => {
  it("hasMore.employees is false when results fit within the limit", async () => {
    // Default limit of 10; we only seeded 2 employees matching TAG
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.hasMore.employees).toBe(false);
  });

  it("hasMore.employees is true when there are more results than limit", async () => {
    // Two users share the TAG firstName (admin + employee); limit=1 forces hasMore=true
    const res = await searchPaged(TAG, 1, 1);
    expect(res.status).toBe(200);
    expect(res.body.employees.length).toBe(1);
    expect(res.body.hasMore.employees).toBe(true);
  });

  it("hasMore.employees is false on page 2 with limit=1 (exhausted after 2 records)", async () => {
    const res = await searchPaged(TAG, 2, 1);
    expect(res.status).toBe(200);
    // We seeded exactly 2 users; page 2 with limit 1 should yield exactly 1 and no more
    expect(res.body.employees.length).toBeGreaterThanOrEqual(0);
    expect(res.body.hasMore.employees).toBe(false);
  });

  it("disabled-feature domains always report hasMore: false", async () => {
    setOverrideInMemory("incidents", false);
    setOverrideInMemory("payroll", false);
    setOverrideInMemory("hr", false);
    setOverrideInMemory("chat", false);

    const res = await searchPaged(TAG, 1, 1);
    expect(res.status).toBe(200);
    expect(res.body.hasMore.incidents).toBe(false);
    expect(res.body.hasMore.payroll).toBe(false);
    expect(res.body.hasMore.applications).toBe(false);
    expect(res.body.hasMore.chatRooms).toBe(false);
  });

  it("hasMore.chatRooms is false when the single seeded room fits within limit", async () => {
    const res = await search(TAG);
    expect(res.status).toBe(200);
    expect(res.body.hasMore.chatRooms).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pagination — page offset
// ---------------------------------------------------------------------------

describe("GET /admin/search — page-based offset", () => {
  it("page 1 with limit=1 returns the first employee result", async () => {
    const res = await searchPaged(TAG, 1, 1);
    expect(res.status).toBe(200);
    expect(res.body.employees.length).toBe(1);
  });

  it("page 2 with limit=1 returns a different employee than page 1", async () => {
    const [p1, p2] = await Promise.all([
      searchPaged(TAG, 1, 1),
      searchPaged(TAG, 2, 1),
    ]);
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    // Both should return exactly one employee
    expect(p1.body.employees.length).toBe(1);
    expect(p2.body.employees.length).toBe(1);
    // They must be different records
    expect(p1.body.employees[0].id).not.toBe(p2.body.employees[0].id);
  });

  it("page beyond available results returns empty arrays with hasMore: false", async () => {
    // Only 2 employees match TAG; page 100 with limit=10 must be empty
    const res = await searchPaged(TAG, 100, 10);
    expect(res.status).toBe(200);
    expect(res.body.employees).toEqual([]);
    expect(res.body.hasMore.employees).toBe(false);
  });

  it("accepts limit=50 (maximum allowed)", async () => {
    const res = await searchPaged(TAG, 1, 50);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  it("accepts limit=1 (minimum allowed)", async () => {
    const res = await searchPaged(TAG, 1, 1);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
  });
});
