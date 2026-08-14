import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  siteManagersTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Multi-position shift creation: POST /shifts/bulk-create makes one shift
// record per position row (transactionally), and POST /shifts/repeat accepts
// base.positions[] where each position becomes its own repeat series.
const TAG = `bulkcreate-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  managerId: string;
  adminToken: string;
  managerToken: string;
  clientId: string;
  siteAId: string; // managed by manager
  siteBId: string; // NOT managed
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Person",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function makeSite(name: string): Promise<string> {
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-${name}`,
      address: "1 Test Way",
      defaultPayRate: "31.00",
      defaultBillRate: "56.00",
    })
    .returning({ id: sitesTable.id });
  return site.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const futureStart = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const futureEnd = () => new Date(Date.now() + 28 * 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.managerId = await makeUser("site_manager", "mgr");
  await db.insert(employeesTable).values({ userId: ctx.managerId, position: "officer", hourlyRate: "30.00", skills: [] });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  ctx.siteAId = await makeSite("siteA");
  ctx.siteBId = await makeSite("siteB");
  await db.insert(siteManagersTable).values({ siteId: ctx.siteAId, userId: ctx.managerId, assignedBy: ctx.adminId });

  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.managerToken = signToken({ userId: ctx.managerId, email: `${TAG}-mgr@example.test`, role: "site_manager" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM site_managers WHERE user_id = ${ctx.managerId}::uuid`);
  await db.execute(sql`DELETE FROM employees WHERE user_id = ${ctx.managerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("POST /shifts/bulk-create — multi-position one-off shifts", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    title: `${TAG}-bulk`,
    siteId: ctx.siteAId,
    startTime: futureStart(),
    endTime: futureEnd(),
    positions: [
      { requiredLicenseLevel: 2, headcount: 3, payRate: "20.00", billRate: "40.00" },
      { requiredLicenseLevel: 3, headcount: 1, payRate: "28.00", billRate: "52.00" },
    ],
    ...over,
  });

  it("creates one shift per position row for an admin (201)", async () => {
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send(body());
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(res.body.shifts).toHaveLength(2);
    const byLevel = Object.fromEntries(
      (res.body.shifts as Array<{ requiredLicenseLevel: number; headcount: number; payRate: string }>).map((s) => [s.requiredLicenseLevel, s]),
    );
    expect(byLevel[2].headcount).toBe(3);
    expect(Number(byLevel[2].payRate)).toBe(20);
    expect(byLevel[3].headcount).toBe(1);
    expect(Number(byLevel[3].payRate)).toBe(28);
  });

  it("rejects two rows with the same level AND same rate (400) and leaves no partial rows", async () => {
    const title = `${TAG}-dup`;
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send(body({
      title,
      positions: [
        { requiredLicenseLevel: 2, headcount: 1, payRate: "20.00", billRate: "40.00" },
        { requiredLicenseLevel: 2, headcount: 2, payRate: "20.00", billRate: "40.00" },
      ],
    }));
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/Duplicate position/i);
    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows).toHaveLength(0);
  });

  it("allows the same license level at two different rates (201) — multi-tier staffing", async () => {
    const title = `${TAG}-multitier`;
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send(body({
      title,
      positions: [
        { requiredLicenseLevel: 3, headcount: 2, payRate: "26.00", billRate: "48.00" },
        { requiredLicenseLevel: 3, headcount: 1, payRate: "30.00", billRate: "55.00" },
      ],
    }));
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.requiredLicenseLevel === 3)).toBe(true);
    expect(new Set(rows.map((r) => Number(r.payRate)))).toEqual(new Set([26, 30]));
  });

  it("rejects empty positions[] (400)", async () => {
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send(body({ positions: [] }));
    expect(res.status).toBe(400);
  });

  it("clamps invalid headcounts to at least 1", async () => {
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send(body({
      title: `${TAG}-clamp`,
      positions: [{ requiredLicenseLevel: 4, headcount: -3, payRate: "35.00", billRate: "60.00" }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.shifts[0].headcount).toBe(1);
  });

  it("rejects endTime <= startTime (400)", async () => {
    const t = futureStart();
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send(body({ startTime: t, endTime: t }));
    expect(res.status).toBe(400);
  });

  it("lets a manager bulk-create at a managed site with rates forced to site defaults (201)", async () => {
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.managerToken)).send(body({
      title: `${TAG}-mgr-ok`,
      positions: [
        { requiredLicenseLevel: 2, headcount: 2, payRate: "99.00", billRate: "99.00" },
        { requiredLicenseLevel: 3, headcount: 1, payRate: "99.00", billRate: "99.00" },
      ],
    }));
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    // Manager response is finance-stripped; verify rates in the DB directly.
    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, `${TAG}-mgr-ok`));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.payRate)).toBe(31);   // site default, NOT the 99 they sent
      expect(Number(r.billRate)).toBe(56);
    }
    // Finance fields stripped from the manager's response.
    for (const s of res.body.shifts as Array<Record<string, unknown>>) {
      expect(s).not.toHaveProperty("billRate");
    }
  });

  it("forbids a manager at an unmanaged site (403)", async () => {
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.managerToken)).send(body({ siteId: ctx.siteBId }));
    expect(res.status).toBe(403);
  });

  it("rejects a manager with no site (400)", async () => {
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.managerToken)).send(body({ siteId: null }));
    expect(res.status).toBe(400);
  });
});

describe("POST /shifts/repeat — multi-position series", () => {
  // Fixed near-future window: next 7 days, all days of week → 7 occurrences.
  const startDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const untilDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  it("creates one series per position (each with its own seriesId)", async () => {
    const title = `${TAG}-repeat-multi`;
    const res = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: {
        title,
        siteId: ctx.siteBId,
        positions: [
          { requiredLicenseLevel: 2, headcount: 2, payRate: "21.00", billRate: "41.00" },
          { requiredLicenseLevel: 4, headcount: 1, payRate: "36.00", billRate: "61.00" },
        ],
      },
      recurrence: { startDate, untilDate, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: "08:00", endTime: "16:00" },
    });
    expect(res.status).toBe(201);
    expect(res.body.positions).toBe(2);
    expect(res.body.created).toBe(res.body.totalOccurrences); // fresh site window → nothing skipped
    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows.length).toBe(res.body.created);
    const seriesIds = new Set(rows.map((r) => r.seriesId));
    expect(seriesIds.size).toBe(2); // one seriesId per position
    const levels = new Set(rows.map((r) => r.requiredLicenseLevel));
    expect(levels).toEqual(new Set([2, 4]));
  });

  it("rejects same-level same-rate duplicates in a repeat request (400)", async () => {
    const res = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: {
        title: `${TAG}-repeat-dup`,
        siteId: ctx.siteBId,
        positions: [
          { requiredLicenseLevel: 3, headcount: 1, payRate: "28.00", billRate: "52.00" },
          { requiredLicenseLevel: 3, headcount: 2, payRate: "28.00", billRate: "52.00" },
        ],
      },
      recurrence: { startDate, untilDate, daysOfWeek: [1], startTime: "08:00", endTime: "16:00" },
    });
    expect(res.status).toBe(400);
  });

  it("allows the same level at two different rate tiers in a repeat request (201)", async () => {
    const title = `${TAG}-repeat-multitier`;
    const res = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: {
        title,
        siteId: ctx.siteBId,
        positions: [
          { requiredLicenseLevel: 2, headcount: 1, payRate: "20.00", billRate: "40.00" },
          { requiredLicenseLevel: 2, headcount: 1, payRate: "24.00", billRate: "46.00" },
        ],
      },
      recurrence: { startDate, untilDate, daysOfWeek: [2], startTime: "09:00", endTime: "17:00" },
    });
    expect(res.status).toBe(201);
    expect(res.body.positions).toBe(2);
    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows.length).toBe(res.body.created);
    expect(new Set(rows.map((r) => r.seriesId)).size).toBe(2); // one series per tier
    expect(rows.every((r) => r.requiredLicenseLevel === 2)).toBe(true);
    expect(new Set(rows.map((r) => Number(r.payRate)))).toEqual(new Set([20, 24]));
  });

  it("skips only same-position occurrences: an existing tier-1 series doesn't block a tier-2 series at the same times", async () => {
    const title = `${TAG}-repeat-tier-idem`;
    const recurrence = { startDate, untilDate, daysOfWeek: [3], startTime: "10:00", endTime: "18:00" };
    // First series: L2 at tier-1 rates.
    const first = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: {
        title,
        siteId: ctx.siteBId,
        positions: [{ requiredLicenseLevel: 2, headcount: 1, payRate: "20.00", billRate: "40.00" }],
      },
      recurrence,
    });
    expect(first.status).toBe(201);
    expect(first.body.created).toBeGreaterThan(0);
    expect(first.body.skippedExisting).toBe(0);

    // Second series: SAME level, SAME site, SAME times, DIFFERENT rates (tier 2).
    // Previously the site+startTime idempotency check reported these as
    // "already exist" and created nothing.
    const second = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: {
        title,
        siteId: ctx.siteBId,
        positions: [{ requiredLicenseLevel: 2, headcount: 1, payRate: "24.00", billRate: "46.00" }],
      },
      recurrence,
    });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(first.body.created);
    expect(second.body.skippedExisting).toBe(0);

    // Third: EXACT re-submission of the second series → fully skipped (idempotent).
    const third = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: {
        title,
        siteId: ctx.siteBId,
        positions: [{ requiredLicenseLevel: 2, headcount: 1, payRate: "24.00", billRate: "46.00" }],
      },
      recurrence,
    });
    expect(third.status).toBe(201);
    expect(third.body.created).toBe(0);
    expect(third.body.skippedExisting).toBe(second.body.created);

    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows.length).toBe(first.body.created + second.body.created);
    expect(new Set(rows.map((r) => Number(r.payRate)))).toEqual(new Set([20, 24]));
  });

  it("still supports the legacy single-position body shape", async () => {
    const title = `${TAG}-repeat-legacy`;
    const res = await request(app).post("/api/shifts/repeat").set(authed(ctx.adminToken)).send({
      base: { title, siteId: ctx.siteAId, requiredLicenseLevel: 3, headcount: 2, payRate: "27.00", billRate: "50.00" },
      recurrence: { startDate, untilDate, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: "22:00", endTime: "06:00" },
    });
    expect(res.status).toBe(201);
    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.requiredLicenseLevel === 3 && r.headcount === 2)).toBe(true);
  });
});
