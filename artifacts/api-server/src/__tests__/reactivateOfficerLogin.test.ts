import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `reactivate-login-${randomUUID().slice(0, 8)}`;
const PASSWORD = "Reactivate123!";
const passwordHash = bcrypt.hashSync(PASSWORD, 4);
const EMAIL = `${TAG}-officer@example.test`;

const DAY = 86400_000;

type Ctx = {
  adminId: string;
  officerId: string;
  adminToken: string;
  siteId: string;
};
const ctx = {} as Ctx;

/** YYYY-MM-DD for a Date (UTC), matching the analytics range param format. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });

  const [officer] = await db
    .insert(usersTable)
    .values({
      email: EMAIL,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.officerId = officer.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: client.id,
      name: `${TAG}-site`,
      address: "1 Reactivate Way",
      defaultBillRate: "40.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // A completed, approved shift ~2 days ago so the officer shows up in the
  // analytics officers list for a window that covers it.
  const now = Date.now();
  const start = new Date(now - 2 * DAY - 8 * 3600_000);
  const end = new Date(now - 2 * DAY);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      status: "upcoming",
      headcount: 1,
      payRate: "20.00",
      billRate: "40.00",
    })
    .returning({ id: shiftsTable.id });
  await db.insert(shiftAssignmentsTable).values({
    shiftId: shift.id,
    employeeId: ctx.officerId,
    status: "accepted",
  });
  await db.insert(timeEntriesTable).values({
    employeeId: ctx.officerId,
    shiftId: shift.id,
    siteId: ctx.siteId,
    clockInTime: start,
    clockOutTime: end,
    hoursWorked: "8.00",
    approvalStatus: "approved",
  });
});

describe("reactivated officer can sign in again", () => {
  const rangeStart = ymd(new Date(Date.now() - 7 * DAY));
  const rangeEnd = ymd(new Date());

  it("logs in while active", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    expect(res.body.user.status).toBe("active");
  });

  it("rejects login after being archived", async () => {
    // Archive exactly the way the portal does: PUT the generic users grid.
    // Also stamp a revocation watermark, mimicking any archive path that
    // bumps tokensValidAfter, to prove reactivation leaves no residue.
    await db
      .update(usersTable)
      .set({ tokensValidAfter: new Date() })
      .where(eq(usersTable.id, ctx.officerId));
    const put = await request(app)
      .put(`/api/admin/tables/users/${ctx.officerId}`)
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ status: "inactive" });
    expect(put.status).toBe(200);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);

    // Analytics officers list reflects the archived state.
    const officers = await request(app)
      .get(`/api/analytics/officers?start=${rangeStart}&end=${rangeEnd}`)
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(officers.status).toBe(200);
    const row = officers.body.find(
      (o: { employeeId: string }) => o.employeeId === ctx.officerId,
    );
    expect(row).toBeDefined();
    expect(row.status).toBe("inactive");
  });

  it("logs in again right after reactivation via the same endpoint", async () => {
    // The Analytics Reactivate button flips status back through the same
    // generic admin CRUD endpoint.
    const put = await request(app)
      .put(`/api/admin/tables/users/${ctx.officerId}`)
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ status: "active" });
    expect(put.status).toBe(200);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    expect(res.body.user.status).toBe("active");

    const officers = await request(app)
      .get(`/api/analytics/officers?start=${rangeStart}&end=${rangeEnd}`)
      .set("Authorization", `Bearer ${ctx.adminToken}`);
    expect(officers.status).toBe(200);
    const row = officers.body.find(
      (o: { employeeId: string }) => o.employeeId === ctx.officerId,
    );
    expect(row).toBeDefined();
    expect(row.status).toBe("active");
  });
});
