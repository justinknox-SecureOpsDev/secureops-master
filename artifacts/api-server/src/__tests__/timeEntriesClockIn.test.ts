import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and, isNull } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  licensesTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `clockin-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  licensedEmployeeId: string;
  unlicensedEmployeeId: string;
  licensedToken: string;
  unlicensedToken: string;
  clientId: string;
  // Site with coords inside the 1-mile resolve radius of (32.7767, -96.7970).
  nearSiteId: string;
};
const ctx = {} as Ctx;

async function makeEmployee(suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

beforeAll(async () => {
  ctx.licensedEmployeeId = await makeEmployee("lic");
  ctx.unlicensedEmployeeId = await makeEmployee("nolic");
  ctx.licensedToken = signToken({
    userId: ctx.licensedEmployeeId,
    email: `${TAG}-lic@example.test`,
    role: "employee",
  });
  ctx.unlicensedToken = signToken({
    userId: ctx.unlicensedEmployeeId,
    email: `${TAG}-nolic@example.test`,
    role: "employee",
  });

  // Only the "licensed" officer gets an unexpired license.
  const futureDate = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  await db.insert(licensesTable).values({
    employeeId: ctx.licensedEmployeeId,
    type: "tx-security",
    level: 3,
    licenseNumber: `${TAG}-LIC`,
    expiryDate: futureDate,
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  // Site at downtown Dallas coords. Test pings will be ~50 ft away
  // (same coords) so resolveNearestSite returns this site.
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-near-site`,
      address: "1 Near Way",
      // Remote coordinates in the South Atlantic far from any seed/real
      // site, so the geo-resolver can ONLY match this fixture's site.
      locationLat: "-54.123456",
      locationLng: "-12.654321",
    })
    .returning({ id: sitesTable.id });
  ctx.nearSiteId = site.id;
});

afterAll(async () => {
  const ids = [ctx.licensedEmployeeId, ctx.unlicensedEmployeeId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM licenses WHERE employee_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function deleteOpenEntries(employeeId: string) {
  await db
    .delete(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, employeeId), isNull(timeEntriesTable.clockOutTime)));
}

describe("POST /time-entries/clock-in geo-resolution", () => {
  it("resolves the nearest site when no shiftId is provided and the officer is within 1 mile", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: -54.123456, lng: -12.654321 }); // same coords as the site
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    // The route should stamp time_entries.siteId with the resolved site
    // so /payroll and /invoices group the entry correctly even though
    // no shiftId was provided.
    const [row] = await db
      .select({ siteId: timeEntriesTable.siteId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, res.body.id));
    expect(row.siteId).toBe(ctx.nearSiteId);

    // Clean up so the next test's "already clocked in" guard doesn't trip.
    await deleteOpenEntries(ctx.licensedEmployeeId);
  });

  it("returns 422 'No Site Nearby' when the officer is outside the 1-mile radius of every site", async () => {
    await deleteOpenEntries(ctx.licensedEmployeeId);
    // Pacific Ocean — guaranteed to be >1 mile from any of our sites.
    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.licensedToken))
      .send({ lat: 0, lng: -160 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No Site Nearby/i);
    expect(res.body.message).toMatch(/not within/i);
  });

  it("blocks an employee with no unexpired license (403 license_expired)", async () => {
    await deleteOpenEntries(ctx.unlicensedEmployeeId);
    const res = await request(app)
      .post("/api/time-entries/clock-in")
      .set(authed(ctx.unlicensedToken))
      .send({ lat: 32.7767, lng: -96.797 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("license_expired");
  });
});
