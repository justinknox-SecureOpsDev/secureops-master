import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, shiftsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Regression for the "missing sites" incident: an admin cleaning up what looked
// like a duplicate hard-deleted a live site, which CASCADE-deleted its QR token
// + scan entries and SET NULL on 59 shifts (silent operational-data loss).
// DELETE /admin/tables/sites/:id must now refuse while dependents exist.
const TAG = `site-del-guard-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; adminToken: string; clientId: string; siteId: string };
const ctx = {} as Ctx;

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
    })
    .returning({ id: usersTable.id });
  ctx.adminId = admin.id;
  ctx.adminToken = signToken({ userId: admin.id, email: `${TAG}-admin@example.test`, role: "admin" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function addShift(): Promise<void> {
  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await db.insert(shiftsTable).values({
    title: `${TAG}-shift`,
    siteId: ctx.siteId,
    startTime: start,
    endTime: new Date(start.getTime() + 4 * 60 * 60 * 1000),
    requiredLicenseLevel: 2,
    headcount: 1,
    status: "upcoming",
  });
}

function siteExists(): Promise<Array<{ id: string }>> {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(sql`${sitesTable.id} = ${ctx.siteId}`);
}

describe("site / client deletion dependency guard", () => {
  it("refuses DELETE /admin/tables/sites/:id with 409 + blockers when shifts exist", async () => {
    await addShift();
    const res = await request(app)
      .delete(`/api/admin/tables/sites/${ctx.siteId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(409);
    expect(res.body.blockers?.shifts).toBeGreaterThanOrEqual(1);
    expect(await siteExists()).toHaveLength(1);
  });

  it("refuses DELETE /sites/:id (dedicated route) with 409 when shifts exist", async () => {
    const res = await request(app).delete(`/api/sites/${ctx.siteId}`).set(authed(ctx.adminToken));
    expect(res.status).toBe(409);
    expect(res.body.blockers?.shifts).toBeGreaterThanOrEqual(1);
    expect(await siteExists()).toHaveLength(1);
  });

  it("refuses DELETE /clients/:id with 409 when a child site has shifts", async () => {
    const res = await request(app)
      .delete(`/api/clients/${ctx.clientId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(409);
    expect(res.body.blockers?.sites).toBeGreaterThanOrEqual(1);
    expect(res.body.blockers?.shifts).toBeGreaterThanOrEqual(1);
    expect(await siteExists()).toHaveLength(1);
  });

  it("refuses DELETE /admin/tables/clients/:id with 409 when a child site has shifts", async () => {
    const res = await request(app)
      .delete(`/api/admin/tables/clients/${ctx.clientId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(409);
    expect(res.body.blockers?.sites).toBeGreaterThanOrEqual(1);
    expect(await siteExists()).toHaveLength(1);
  });

  it("allows the delete once every dependent is gone", async () => {
    await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
    const res = await request(app)
      .delete(`/api/admin/tables/sites/${ctx.siteId}`)
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(204);
    expect(await siteExists()).toHaveLength(0);
  });
});
