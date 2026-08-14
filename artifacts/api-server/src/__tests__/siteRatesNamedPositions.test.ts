import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, siteRatesTable, shiftsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Named position rate cards.
 *
 * A site's rate card is a list of NAMED positions rather than a fixed
 * "Rate 1 / Rate 2 / Rate 3" grid. This pins:
 *   - more than three positions at ONE license level (the old cap + the
 *     "rateTier must be 1, 2, or 3" validation are both gone),
 *   - a blank name and a duplicate name at the same level are rejected,
 *   - editing a rate targets THAT rate by id (name/pay/bill in place) and
 *     never overwrites a different one,
 *   - legacy rows with no name keep working and read back as "Rate <slot>",
 *   - renaming a position flows through to what a shift displays, while a
 *     shift whose rate was deleted keeps the name it was created with.
 */
const TAG = `namedpos-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; adminToken: string; clientId: string; siteId: string };
const ctx = {} as Ctx;

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const futureStart = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const futureEnd = () => new Date(Date.now() + 28 * 60 * 60 * 1000).toISOString();

async function addPosition(body: Record<string, unknown>) {
  return request(app).post(`/api/admin/sites/${ctx.siteId}/rates`).set(authed(ctx.adminToken)).send(body);
}

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
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: client.id,
      name: `${TAG}-site`,
      address: "1 Test Way",
      defaultPayRate: "20.00",
      defaultBillRate: "40.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM site_rates WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("site rate card — named positions CRUD", () => {
  it("accepts FIVE named positions at one license level (no three-per-level cap)", async () => {
    const names = ["Tier 1", "Floor Manager", "Overnight Supervisor", "Event Lead", "Relief"];
    const ids: string[] = [];
    for (const name of names) {
      const res = await addPosition({ name, licenseLevel: 2, payRate: 20 + ids.length, billRate: 40 + ids.length });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.name).toBe(name);
      ids.push(res.body.id);
    }
    expect(new Set(ids).size).toBe(5);

    const list = await request(app).get(`/api/admin/sites/${ctx.siteId}/rates`).set(authed(ctx.adminToken));
    expect(list.status).toBe(200);
    const l2 = (list.body as Array<{ licenseLevel: number; name: string | null; rateTier: number }>)
      .filter((r) => r.licenseLevel === 2);
    expect(l2.map((r) => r.name)).toEqual(expect.arrayContaining(names));
    // Internal slot numbers are auto-assigned and go past the old 1..3 range.
    expect(Math.max(...l2.map((r) => r.rateTier))).toBeGreaterThan(3);
  });

  it("rejects a blank name and a duplicate name at the same level", async () => {
    const blank = await addPosition({ name: "   ", licenseLevel: 3, payRate: 28, billRate: 52 });
    expect(blank.status).toBe(400);
    expect(String(blank.body.message)).toMatch(/name/i);

    const first = await addPosition({ name: "Armed Post", licenseLevel: 3, payRate: 28, billRate: 52 });
    expect(first.status).toBe(201);

    const dup = await addPosition({ name: "armed post", licenseLevel: 3, payRate: 30, billRate: 55 });
    expect(dup.status).toBe(400);
    expect(String(dup.body.message)).toMatch(/already a position/i);

    // The same name at a DIFFERENT license level is fine.
    const other = await addPosition({ name: "Armed Post", licenseLevel: 4, payRate: 36, billRate: 61 });
    expect(other.status).toBe(201);
  });

  it("edits one rate in place by id without touching its siblings", async () => {
    const a = await addPosition({ name: "Edit A", licenseLevel: 1, payRate: 15, billRate: 30 });
    const b = await addPosition({ name: "Edit B", licenseLevel: 1, payRate: 16, billRate: 32 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const upd = await request(app)
      .put(`/api/admin/site-rates/${a.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ name: "Edit A renamed", payRate: 17.5, billRate: 33.25 });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.id).toBe(a.body.id);
    expect(upd.body.name).toBe("Edit A renamed");
    expect(Number(upd.body.payRate)).toBe(17.5);

    const [sibling] = await db.select().from(siteRatesTable).where(eq(siteRatesTable.id, b.body.id));
    expect(sibling.name).toBe("Edit B");
    expect(Number(sibling.payRate)).toBe(16);

    // Renaming onto a sibling's name at the same level is rejected.
    const clash = await request(app)
      .put(`/api/admin/site-rates/${a.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ name: "Edit B" });
    expect(clash.status).toBe(400);

    // Renaming to its own name is a no-op, not a self-collision.
    const same = await request(app)
      .put(`/api/admin/site-rates/${a.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ name: "Edit A renamed" });
    expect(same.status).toBe(200);
  });

  it("keeps legacy unnamed rates working with a slot-number fallback name", async () => {
    const [legacy] = await db
      .insert(siteRatesTable)
      .values({ siteId: ctx.siteId, licenseLevel: 4, rateTier: 9, payRate: "38.00", billRate: "66.00" })
      .returning({ id: siteRatesTable.id });

    const shift = await request(app).post("/api/shifts").set(authed(ctx.adminToken)).send({
      title: `${TAG}-legacy`,
      siteId: ctx.siteId,
      startTime: futureStart(),
      endTime: futureEnd(),
      requiredLicenseLevel: 4,
      headcount: 1,
      payRate: "38.00",
      billRate: "66.00",
      siteRateId: legacy.id,
    });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const read = await request(app).get(`/api/shifts/${shift.body.id}`).set(authed(ctx.adminToken));
    expect(read.status).toBe(200);
    expect(read.body.positionName).toBe("Rate 9");
  });
});

describe("position names on shifts", () => {
  it("renaming a position updates linked shifts; deleting it keeps the captured name", async () => {
    const pos = await addPosition({ name: "Dock Watch", licenseLevel: 2, payRate: 22, billRate: 44 });
    expect(pos.status).toBe(201);

    const created = await request(app).post("/api/shifts").set(authed(ctx.adminToken)).send({
      title: `${TAG}-rename`,
      siteId: ctx.siteId,
      startTime: futureStart(),
      endTime: futureEnd(),
      requiredLicenseLevel: 2,
      headcount: 1,
      payRate: "22.00",
      billRate: "44.00",
      siteRateId: pos.body.id,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const shiftId = created.body.id as string;

    // Snapshot captured at creation.
    const [row] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
    expect(row.positionName).toBe("Dock Watch");

    // Rename → the LIVE name wins on read.
    const renamed = await request(app)
      .put(`/api/admin/site-rates/${pos.body.id}`)
      .set(authed(ctx.adminToken))
      .send({ name: "Dock Supervisor" });
    expect(renamed.status).toBe(200);

    const afterRename = await request(app).get(`/api/shifts/${shiftId}`).set(authed(ctx.adminToken));
    expect(afterRename.body.positionName).toBe("Dock Supervisor");

    // Delete the rate → the shift falls back to the name it was created with.
    const del = await request(app).delete(`/api/admin/site-rates/${pos.body.id}`).set(authed(ctx.adminToken));
    expect(del.status).toBe(200);

    const afterDelete = await request(app).get(`/api/shifts/${shiftId}`).set(authed(ctx.adminToken));
    expect(afterDelete.body.siteRateId).toBeFalsy();
    expect(afterDelete.body.positionName).toBe("Dock Watch");
  });

  it("staffs three different named positions at one level on a single shift date", async () => {
    const made = [];
    for (const [i, name] of ["Gate A", "Gate B", "Gate C"].entries()) {
      const r = await addPosition({ name, licenseLevel: 3, payRate: 30 + i, billRate: 55 + i });
      expect(r.status).toBe(201);
      made.push(r.body);
    }
    const title = `${TAG}-three-l3`;
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send({
      title,
      siteId: ctx.siteId,
      startTime: futureStart(),
      endTime: futureEnd(),
      positions: made.map((m) => ({
        requiredLicenseLevel: 3,
        headcount: 1,
        payRate: m.payRate,
        billRate: m.billRate,
        siteRateId: m.id,
      })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(3);

    const rows = await db.select().from(shiftsTable).where(eq(shiftsTable.title, title));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.requiredLicenseLevel === 3)).toBe(true);
    expect(new Set(rows.map((r) => r.positionName))).toEqual(new Set(["Gate A", "Gate B", "Gate C"]));
  });

  it("rejects the SAME named position twice and says so by name", async () => {
    const pos = await addPosition({ name: "Lobby Desk", licenseLevel: 2, payRate: 21, billRate: 42 });
    expect(pos.status).toBe(201);
    const res = await request(app).post("/api/shifts/bulk-create").set(authed(ctx.adminToken)).send({
      title: `${TAG}-dup-named`,
      siteId: ctx.siteId,
      startTime: futureStart(),
      endTime: futureEnd(),
      positions: [
        { requiredLicenseLevel: 2, headcount: 1, payRate: "21.00", billRate: "42.00", siteRateId: pos.body.id },
        { requiredLicenseLevel: 2, headcount: 2, payRate: "21.00", billRate: "42.00", siteRateId: pos.body.id },
      ],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain("Lobby Desk");
    expect(String(res.body.message)).not.toMatch(/rate tier/i);
  });
});
