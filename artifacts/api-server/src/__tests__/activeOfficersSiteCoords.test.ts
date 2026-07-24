import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  timeEntriesTable,
  radioChannelsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Verify that GET /admin/active-officers returns siteLat, siteLng, and
// siteChannelId correctly for geocoded shifts, and nulls when coords or an
// active channel are absent.

const TAG = `active-officers-coords-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  adminToken: string;
  clientId: string;
  // geocoded site + channel
  geoSiteId: string;
  geoChannelId: string;
  geoShiftId: string;
  geoOfficerId: string;
  geoTimeEntryId: string;
  // no-coords site
  nocoordSiteId: string;
  nocoordShiftId: string;
  nocoordOfficerId: string;
  nocoordTimeEntryId: string;
  // archived channel
  archivedSiteId: string;
  archivedChannelId: string;
  archivedShiftId: string;
  archivedOfficerId: string;
  archivedTimeEntryId: string;
  // non-site-scoped channel on a geocoded site
  globalChSiteId: string;
  globalChOfficerId: string;
  globalChShiftId: string;
  globalChTimeEntryId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function makeDates() {
  const start = new Date(Date.now() - 60 * 60 * 1000);
  const end = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return { start, end };
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  // --- Geocoded site with an active site-scoped channel ---
  const [geoSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-geo-site`,
      address: "100 Geo Ave",
      locationLat: "30.267200",
      locationLng: "-97.743100",
    })
    .returning({ id: sitesTable.id });
  ctx.geoSiteId = geoSite.id;

  const [geoCh] = await db
    .insert(radioChannelsTable)
    .values({ name: `${TAG}-geo-channel`, scope: "site", siteId: ctx.geoSiteId, adminOnly: false })
    .returning({ id: radioChannelsTable.id });
  ctx.geoChannelId = geoCh.id;

  const { start, end } = makeDates();
  const [geoShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-geo-shift`,
      siteId: ctx.geoSiteId,
      startTime: start,
      endTime: end,
      requiredLicenseLevel: 1,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.geoShiftId = geoShift.id;

  ctx.geoOfficerId = await makeUser("employee", "geo-officer");
  const [geoEntry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: ctx.geoOfficerId,
      shiftId: ctx.geoShiftId,
      clockInTime: start,
    })
    .returning({ id: timeEntriesTable.id });
  ctx.geoTimeEntryId = geoEntry.id;

  // --- No-coords site (locationLat/Lng null) ---
  const [nocoordSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-nocoord-site`,
      address: "200 Blank St",
    })
    .returning({ id: sitesTable.id });
  ctx.nocoordSiteId = nocoordSite.id;

  const { start: ncStart, end: ncEnd } = makeDates();
  const [nocoordShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-nocoord-shift`,
      siteId: ctx.nocoordSiteId,
      startTime: ncStart,
      endTime: ncEnd,
      requiredLicenseLevel: 1,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.nocoordShiftId = nocoordShift.id;

  ctx.nocoordOfficerId = await makeUser("employee", "nocoord-officer");
  const [ncEntry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: ctx.nocoordOfficerId,
      shiftId: ctx.nocoordShiftId,
      clockInTime: ncStart,
    })
    .returning({ id: timeEntriesTable.id });
  ctx.nocoordTimeEntryId = ncEntry.id;

  // --- Geocoded site with an ARCHIVED channel ---
  const [archivedSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-archived-site`,
      address: "300 Archive Rd",
      locationLat: "29.700000",
      locationLng: "-95.400000",
    })
    .returning({ id: sitesTable.id });
  ctx.archivedSiteId = archivedSite.id;

  const [archivedCh] = await db
    .insert(radioChannelsTable)
    .values({
      name: `${TAG}-archived-channel`,
      scope: "site",
      siteId: ctx.archivedSiteId,
      adminOnly: false,
      archivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })
    .returning({ id: radioChannelsTable.id });
  ctx.archivedChannelId = archivedCh.id;

  const { start: arStart, end: arEnd } = makeDates();
  const [archivedShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-archived-shift`,
      siteId: ctx.archivedSiteId,
      startTime: arStart,
      endTime: arEnd,
      requiredLicenseLevel: 1,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.archivedShiftId = archivedShift.id;

  ctx.archivedOfficerId = await makeUser("employee", "archived-officer");
  const [arEntry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: ctx.archivedOfficerId,
      shiftId: ctx.archivedShiftId,
      clockInTime: arStart,
    })
    .returning({ id: timeEntriesTable.id });
  ctx.archivedTimeEntryId = arEntry.id;

  // --- Geocoded site with a non-site-scoped (global) channel only ---
  // The active-officers join must NOT pick up global channels even though
  // they share a siteId — only scope='site' channels qualify.
  const [globalChSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-globalch-site`,
      address: "400 Global Blvd",
      locationLat: "32.000000",
      locationLng: "-96.000000",
    })
    .returning({ id: sitesTable.id });
  ctx.globalChSiteId = globalChSite.id;

  // Insert a global-scoped channel that happens to have a siteId set.
  // The route must exclude it because scope !== 'site'.
  await db.insert(radioChannelsTable).values({
    name: `${TAG}-globalch-channel`,
    scope: "global",
    siteId: ctx.globalChSiteId,
    adminOnly: false,
  });

  const { start: gcStart, end: gcEnd } = makeDates();
  const [gcShift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-globalch-shift`,
      siteId: ctx.globalChSiteId,
      startTime: gcStart,
      endTime: gcEnd,
      requiredLicenseLevel: 1,
      headcount: 1,
      status: "upcoming",
    })
    .returning({ id: shiftsTable.id });
  ctx.globalChShiftId = gcShift.id;

  ctx.globalChOfficerId = await makeUser("employee", "globalch-officer");
  const [gcEntry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: ctx.globalChOfficerId,
      shiftId: ctx.globalChShiftId,
      clockInTime: gcStart,
    })
    .returning({ id: timeEntriesTable.id });
  ctx.globalChTimeEntryId = gcEntry.id;
});

afterAll(async () => {
  // Delete open time entries first (no clock-out), then shift/site/client rows.
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id IN (${sql.raw(`'${ctx.geoOfficerId}','${ctx.nocoordOfficerId}','${ctx.archivedOfficerId}','${ctx.globalChOfficerId}'`)})`);
  await db.execute(sql`DELETE FROM radio_channels WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("GET /admin/active-officers — site coords and channel fields", () => {
  it("returns non-null siteLat, siteLng, siteChannelId for an officer at a geocoded site with an active channel", async () => {
    const res = await request(app)
      .get("/api/admin/active-officers")
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(200);
    const officer = (res.body as Array<{ userId: string; siteLat: unknown; siteLng: unknown; siteChannelId: unknown }>)
      .find((r) => r.userId === ctx.geoOfficerId);
    expect(officer, "geocoded officer should appear in active list").toBeDefined();
    expect(officer!.siteLat).not.toBeNull();
    expect(officer!.siteLng).not.toBeNull();
    expect(officer!.siteChannelId).toBe(ctx.geoChannelId);
  });

  it("returns null siteLat, siteLng, and null siteChannelId for an officer at a site with no coordinates", async () => {
    const res = await request(app)
      .get("/api/admin/active-officers")
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(200);
    const officer = (res.body as Array<{ userId: string; siteLat: unknown; siteLng: unknown; siteChannelId: unknown }>)
      .find((r) => r.userId === ctx.nocoordOfficerId);
    expect(officer, "no-coord officer should appear in active list").toBeDefined();
    expect(officer!.siteLat).toBeNull();
    expect(officer!.siteLng).toBeNull();
    expect(officer!.siteChannelId).toBeNull();
  });

  it("returns null siteChannelId when the site's only channel is archived", async () => {
    const res = await request(app)
      .get("/api/admin/active-officers")
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(200);
    const officer = (res.body as Array<{ userId: string; siteLat: unknown; siteLng: unknown; siteChannelId: unknown }>)
      .find((r) => r.userId === ctx.archivedOfficerId);
    expect(officer, "archived-channel officer should appear in active list").toBeDefined();
    // coords should still be non-null (the site has geocoords)
    expect(officer!.siteLat).not.toBeNull();
    expect(officer!.siteLng).not.toBeNull();
    // channel must be null — the only channel for this site is archived
    expect(officer!.siteChannelId).toBeNull();
  });

  it("returns null siteChannelId when the site's only channel is non-site-scoped (global)", async () => {
    const res = await request(app)
      .get("/api/admin/active-officers")
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(200);
    const officer = (res.body as Array<{ userId: string; siteLat: unknown; siteLng: unknown; siteChannelId: unknown }>)
      .find((r) => r.userId === ctx.globalChOfficerId);
    expect(officer, "global-channel officer should appear in active list").toBeDefined();
    // site has geocoords so these should be present
    expect(officer!.siteLat).not.toBeNull();
    expect(officer!.siteLng).not.toBeNull();
    // global-scoped channel must not be returned — only scope='site' channels qualify
    expect(officer!.siteChannelId).toBeNull();
  });
});
