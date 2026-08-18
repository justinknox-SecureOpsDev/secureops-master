import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// The per-site auto clock-out delay moves payroll whenever the site also pays
// the grace period, so the admin grid must never quietly "fix" what an admin
// typed. The shared int coercion truncates decimals (45.5 -> 45) and turns
// junk into null (which would silently clear the override), so the sites
// coercer validates the supplied value BEFORE coercion — these tests pin that
// down on all three write paths: create, update, and bulk import.
const TAG = `site-acod-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminToken: string; clientId: string; siteId: string };
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
  ctx.adminToken = signToken({ userId: admin.id, email: `${TAG}-admin@example.test`, role: "admin" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way", autoClockOutDelayMinutes: 45 })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function auth() {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

async function storedDelay(siteId: string) {
  const [row] = await db
    .select({
      delay: sitesTable.autoClockOutDelayMinutes,
      payGrace: sitesTable.autoClockOutPayGrace,
    })
    .from(sitesTable)
    .where(eq(sitesTable.id, siteId));
  return row;
}

describe("admin grid — per-site auto clock-out delay validation", () => {
  it("rejects a fractional delay on create instead of truncating it", async () => {
    const name = `${TAG}-create-decimal`;
    const res = await request(app)
      .post("/api/admin/tables/sites")
      .set(auth())
      .send({ clientId: ctx.clientId, name, address: "2 Test Way", autoClockOutDelayMinutes: 45.5 });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/whole number of minutes/i);

    const [created] = await db.select().from(sitesTable).where(eq(sitesTable.name, name));
    expect(created).toBeUndefined();
  });

  it("rejects a non-numeric delay on create instead of silently clearing it", async () => {
    const name = `${TAG}-create-junk`;
    const res = await request(app)
      .post("/api/admin/tables/sites")
      .set(auth())
      .send({ clientId: ctx.clientId, name, address: "3 Test Way", autoClockOutDelayMinutes: "soon" });

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/whole number of minutes/i);

    const [created] = await db.select().from(sitesTable).where(eq(sitesTable.name, name));
    expect(created).toBeUndefined();
  });

  it("accepts a whole-minute delay (and the paid-grace flag) on create", async () => {
    const name = `${TAG}-create-ok`;
    const res = await request(app)
      .post("/api/admin/tables/sites")
      .set(auth())
      .send({
        clientId: ctx.clientId,
        name,
        address: "4 Test Way",
        autoClockOutDelayMinutes: "45",
        autoClockOutPayGrace: true,
      });

    expect(res.status).toBe(201);
    const [created] = await db.select().from(sitesTable).where(eq(sitesTable.name, name));
    expect(created.autoClockOutDelayMinutes).toBe(45);
    expect(created.autoClockOutPayGrace).toBe(true);
  });

  it("rejects a fractional delay on update and leaves the stored value alone", async () => {
    const res = await request(app)
      .put(`/api/admin/tables/sites/${ctx.siteId}`)
      .set(auth())
      .send({ autoClockOutDelayMinutes: 45.5 });

    expect(res.status).toBe(400);
    expect(await storedDelay(ctx.siteId)).toMatchObject({ delay: 45 });
  });

  it("rejects a non-numeric delay on update and leaves the stored value alone", async () => {
    const res = await request(app)
      .put(`/api/admin/tables/sites/${ctx.siteId}`)
      .set(auth())
      .send({ autoClockOutDelayMinutes: "forty five" });

    expect(res.status).toBe(400);
    expect(await storedDelay(ctx.siteId)).toMatchObject({ delay: 45 });
  });

  it("rejects an out-of-range delay on update", async () => {
    const res = await request(app)
      .put(`/api/admin/tables/sites/${ctx.siteId}`)
      .set(auth())
      .send({ autoClockOutDelayMinutes: 99999 });

    expect(res.status).toBe(400);
    expect(await storedDelay(ctx.siteId)).toMatchObject({ delay: 45 });
  });

  it("treats an explicit blank as 'use the default' and clears the override", async () => {
    const res = await request(app)
      .put(`/api/admin/tables/sites/${ctx.siteId}`)
      .set(auth())
      .send({ autoClockOutDelayMinutes: "" });

    expect(res.status).toBe(200);
    expect(await storedDelay(ctx.siteId)).toMatchObject({ delay: null });

    // Put it back so later assertions in this file are not order-dependent.
    await db
      .update(sitesTable)
      .set({ autoClockOutDelayMinutes: 45 })
      .where(eq(sitesTable.id, ctx.siteId));
  });

  it("fails only the offending row on bulk import, without inserting it", async () => {
    const badName = `${TAG}-import-bad`;
    const goodName = `${TAG}-import-good`;
    const res = await request(app)
      .post("/api/admin/import/sites")
      .set(auth())
      .send({
        rows: [
          { clientId: ctx.clientId, name: badName, address: "5 Test Way", autoClockOutDelayMinutes: 45.5 },
          { clientId: ctx.clientId, name: goodName, address: "6 Test Way", autoClockOutDelayMinutes: 30 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.results[0]).toMatchObject({ index: 0, ok: false });
    expect(String(res.body.results[0].error)).toMatch(/whole number of minutes/i);
    expect(res.body.results[1]).toMatchObject({ index: 1, ok: true });

    const [bad] = await db.select().from(sitesTable).where(eq(sitesTable.name, badName));
    expect(bad).toBeUndefined();
    const [good] = await db.select().from(sitesTable).where(eq(sitesTable.name, goodName));
    expect(good.autoClockOutDelayMinutes).toBe(30);
  });
});
