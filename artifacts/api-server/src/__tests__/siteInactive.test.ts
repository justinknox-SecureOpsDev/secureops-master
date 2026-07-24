import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Sites can be retired ("inactive") instead of hard-deleted (which is
// 409-blocked while dependents exist). Inactive sites must vanish from every
// operational surface — GET /sites pickers, the officer clock-in site picker,
// and new-shift creation — while staying reachable for management views via
// includeInactive=true and remaining fully editable (reactivation).
const TAG = `site-inactive-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminToken: string;
  clientId: string;
  activeSiteId: string;
  inactiveSiteId: string;
};
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

  // No coordinates on either site so the geo nearest-site resolver can never
  // pick these rows up (avoids polluting other clock-in tests).
  const [active] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-active`, address: "1 Active Way" })
    .returning({ id: sitesTable.id });
  ctx.activeSiteId = active.id;

  const [inactive] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-inactive`, address: "2 Retired Rd", status: "inactive" })
    .returning({ id: sitesTable.id });
  ctx.inactiveSiteId = inactive.id;
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

describe("inactive sites", () => {
  it("GET /sites hides inactive sites by default", async () => {
    const res = await request(app).get(`/api/sites?clientId=${ctx.clientId}`).set(authed());
    expect(res.status).toBe(200);
    const ids = res.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(ctx.activeSiteId);
    expect(ids).not.toContain(ctx.inactiveSiteId);
  });

  it("GET /sites?includeInactive=true returns inactive sites with their status", async () => {
    const res = await request(app)
      .get(`/api/sites?clientId=${ctx.clientId}&includeInactive=true`)
      .set(authed());
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((s: { id: string; status: string }) => [s.id, s.status]));
    expect(byId.get(ctx.activeSiteId)).toBe("active");
    expect(byId.get(ctx.inactiveSiteId)).toBe("inactive");
  });

  it("GET /me/clock-in-sites (admin view) excludes inactive sites", async () => {
    const res = await request(app).get("/api/me/clock-in-sites").set(authed());
    expect(res.status).toBe(200);
    const ids = res.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(ctx.activeSiteId);
    expect(ids).not.toContain(ctx.inactiveSiteId);
  });

  it("POST /shifts refuses an inactive site with a clear message", async () => {
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const res = await request(app)
      .post("/api/shifts")
      .set(authed())
      .send({
        title: `${TAG}-shift-blocked`,
        siteId: ctx.inactiveSiteId,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 4 * 60 * 60 * 1000).toISOString(),
        payRate: 20,
        billRate: 35,
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inactive/i);
  });

  it("POST /shifts/repeat refuses an inactive site", async () => {
    const res = await request(app)
      .post("/api/shifts/repeat")
      .set(authed())
      .send({
        base: { title: `${TAG}-series-blocked`, siteId: ctx.inactiveSiteId, payRate: 20, billRate: 35 },
        recurrence: {
          startDate: "2030-01-07",
          untilDate: "2030-01-14",
          daysOfWeek: [1, 2],
          startTime: "08:00",
          endTime: "16:00",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inactive/i);
  });

  it("PUT /sites/:id rejects an invalid status value", async () => {
    const res = await request(app)
      .put(`/api/sites/${ctx.activeSiteId}`)
      .set(authed())
      .send({ status: "retired" });
    expect(res.status).toBe(400);
  });

  it("PUT /sites/:id can deactivate and reactivate a site", async () => {
    const off = await request(app)
      .put(`/api/sites/${ctx.activeSiteId}`)
      .set(authed())
      .send({ status: "inactive" });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe("inactive");

    // Hidden from the default list while inactive…
    const hidden = await request(app).get(`/api/sites?clientId=${ctx.clientId}`).set(authed());
    expect(hidden.body.map((s: { id: string }) => s.id)).not.toContain(ctx.activeSiteId);

    // …and back after reactivation.
    const on = await request(app)
      .put(`/api/sites/${ctx.activeSiteId}`)
      .set(authed())
      .send({ status: "active" });
    expect(on.status).toBe(200);
    expect(on.body.status).toBe("active");

    const visible = await request(app).get(`/api/sites?clientId=${ctx.clientId}`).set(authed());
    expect(visible.body.map((s: { id: string }) => s.id)).toContain(ctx.activeSiteId);
  });
});
