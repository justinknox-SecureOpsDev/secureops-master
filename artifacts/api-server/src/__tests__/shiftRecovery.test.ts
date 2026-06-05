import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, shiftsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Companion to the site-delete guard: after a site was hard-deleted, its shifts
// survive with site_id = NULL (ON DELETE SET NULL). These endpoints let an admin
// recreate the site and reattach the orphaned shifts. Reattach must only ever
// touch currently-orphaned rows (site_id IS NULL) so it can't steal a shift that
// already belongs to another site, and is safe to re-run.
const TAG = `shift-recovery-${randomUUID().slice(0, 8)}`;
const ORPHAN_TITLE = `${TAG}-orphan`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminToken: string; siteId: string; otherSiteId: string };
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

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: client.id, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [other] = await db
    .insert(sitesTable)
    .values({ clientId: client.id, name: `${TAG}-other-site`, address: "2 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.otherSiteId = other.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed() {
  return { Authorization: `Bearer ${ctx.adminToken}` };
}

async function addOrphan(title = ORPHAN_TITLE, clientName: string | null = `${TAG}-client`): Promise<string> {
  const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const [row] = await db
    .insert(shiftsTable)
    .values({
      title,
      siteId: null,
      clientName,
      startTime: start,
      endTime: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  return row.id;
}

async function siteIdForShift(id: string): Promise<string | null> {
  const [row] = await db
    .select({ siteId: shiftsTable.siteId })
    .from(shiftsTable)
    .where(sql`${shiftsTable.id} = ${id}`);
  return row?.siteId ?? null;
}

describe("orphaned-shift recovery", () => {
  it("lists orphaned shifts grouped by title", async () => {
    await addOrphan();
    await addOrphan();
    const res = await request(app).get("/api/admin/orphaned-shifts").set(authed());
    expect(res.status).toBe(200);
    const group = (res.body.groups as Array<{ title: string; shiftCount: number }>).find(
      (g) => g.title === ORPHAN_TITLE,
    );
    expect(group?.shiftCount).toBeGreaterThanOrEqual(2);
    expect(res.body.totalShifts).toBeGreaterThanOrEqual(2);
  });

  it("reattaches orphaned shifts to a chosen site by (title, clientName) group", async () => {
    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId, groups: [{ title: ORPHAN_TITLE, clientName: `${TAG}-client` }] });
    expect(res.status).toBe(200);
    expect(res.body.reattached).toBeGreaterThanOrEqual(2);
    expect(res.body.siteId).toBe(ctx.siteId);
  });

  it("never moves a shift that already belongs to another site", async () => {
    // Already-attached shift from the previous test; a second reattach to a
    // different site must be a no-op for it (isNull guard).
    const before = await request(app).get("/api/admin/orphaned-shifts").set(authed());
    const stillOrphan = (before.body.groups as Array<{ title: string }>).some(
      (g) => g.title === ORPHAN_TITLE,
    );
    expect(stillOrphan).toBe(false);

    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.otherSiteId, groups: [{ title: ORPHAN_TITLE, clientName: `${TAG}-client` }] });
    expect(res.status).toBe(200);
    expect(res.body.reattached).toBe(0);
  });

  it("matches on (title, clientName) — same title under a different client is NOT moved", async () => {
    // Two orphan groups that share a title but belonged to different clients
    // (the duplicate-title-across-sites case). Reattaching one group must leave
    // the other orphaned.
    const dupTitle = `${TAG}-dup`;
    const aId = await addOrphan(dupTitle, `${TAG}-clientA`);
    const bId = await addOrphan(dupTitle, `${TAG}-clientB`);

    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId, groups: [{ title: dupTitle, clientName: `${TAG}-clientA` }] });
    expect(res.status).toBe(200);
    expect(res.body.reattached).toBe(1);
    expect(await siteIdForShift(aId)).toBe(ctx.siteId);
    expect(await siteIdForShift(bId)).toBeNull();
  });

  it("matches a group with a NULL clientName via IS NOT DISTINCT FROM", async () => {
    const nullTitle = `${TAG}-nullclient`;
    const id = await addOrphan(nullTitle, null);
    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId, groups: [{ title: nullTitle, clientName: null }] });
    expect(res.status).toBe(200);
    expect(res.body.reattached).toBe(1);
    expect(await siteIdForShift(id)).toBe(ctx.siteId);
  });

  it("treats NULL clientName and empty-string clientName as distinct groups", async () => {
    const t = `${TAG}-nullvsempty`;
    const nullId = await addOrphan(t, null);
    const emptyId = await addOrphan(t, "");

    // Reattaching the NULL group must not pull in the empty-string row.
    const resNull = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId, groups: [{ title: t, clientName: null }] });
    expect(resNull.status).toBe(200);
    expect(resNull.body.reattached).toBe(1);
    expect(await siteIdForShift(nullId)).toBe(ctx.siteId);
    expect(await siteIdForShift(emptyId)).toBeNull();

    // And the empty-string group can then be reattached on its own.
    const resEmpty = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId, groups: [{ title: t, clientName: "" }] });
    expect(resEmpty.status).toBe(200);
    expect(resEmpty.body.reattached).toBe(1);
    expect(await siteIdForShift(emptyId)).toBe(ctx.siteId);
  });

  it("reattaches a specific shift by id", async () => {
    const id = await addOrphan(`${TAG}-byid`);
    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId, shiftIds: [id] });
    expect(res.status).toBe(200);
    expect(res.body.reattached).toBe(1);
    expect(await siteIdForShift(id)).toBe(ctx.siteId);
  });

  it("rejects a request with neither groups nor shiftIds (400)", async () => {
    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: ctx.siteId });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target site does not exist", async () => {
    const res = await request(app)
      .post("/api/admin/orphaned-shifts/reattach")
      .set(authed())
      .send({ siteId: randomUUID(), groups: [{ title: ORPHAN_TITLE, clientName: `${TAG}-client` }] });
    expect(res.status).toBe(404);
  });
});
