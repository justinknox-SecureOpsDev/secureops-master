import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, shiftsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Regression: shift.status stays "upcoming" even after the shift's time has
// passed (status is never auto-advanced). The admin dashboard "Upcoming
// Shifts" list/count must therefore bound by endTime>=now, not filter on
// status alone, or long-past shifts leak into the upcoming surface.
const TAG = `dash-upcoming-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

const ctx = {} as { adminId: string; adminToken: string; siteId: string; clientId: string };

beforeAll(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin-${randomUUID().slice(0, 6)}@example.test`,
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

  const [client] = await db.insert(clientsTable).values({ name: `${TAG}-client` }).returning({ id: clientsTable.id });
  ctx.clientId = client.id;
  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // A past shift still flagged status=upcoming (the bug condition)…
  const pastStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await db.insert(shiftsTable).values({
    title: `${TAG}-PAST`,
    siteId: ctx.siteId,
    startTime: pastStart,
    endTime: new Date(pastStart.getTime() + 4 * 60 * 60 * 1000),
    requiredLicenseLevel: 2,
    headcount: 1,
    status: "upcoming",
  });
  // …and a genuinely future one.
  const futureStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  await db.insert(shiftsTable).values({
    title: `${TAG}-FUTURE`,
    siteId: ctx.siteId,
    startTime: futureStart,
    endTime: new Date(futureStart.getTime() + 4 * 60 * 60 * 1000),
    requiredLicenseLevel: 2,
    headcount: 1,
    status: "upcoming",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("GET /dashboard/admin-summary upcoming shifts", () => {
  it("never surfaces a past shift still flagged status=upcoming", async () => {
    const res = await request(app)
      .get("/api/dashboard/admin-summary")
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(res.status).toBe(200);

    const list = res.body.upcomingShiftsList as Array<{ title: string; endTime: string }>;
    // The tagged past row must never appear (it is ordered earliest, so a
    // status-only filter would have placed it at the very front).
    expect(list.map((s) => s.title)).not.toContain(`${TAG}-PAST`);
    // Invariant: nothing in the list has already ended.
    const now = Date.now();
    for (const s of list) {
      expect(new Date(s.endTime).getTime()).toBeGreaterThanOrEqual(now);
    }
  });
});
