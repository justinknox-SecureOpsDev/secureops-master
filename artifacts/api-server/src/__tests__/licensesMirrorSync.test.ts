import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { db, usersTable, employeesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// The employees.siaLicense* columns are the denormalized "Licence" summary the
// admin OfficerProfile + profile PDF render. Creating/editing a license via
// /licenses must refresh that snapshot from the officer's ACTIVE license
// (latest expiry). These tests lock that behavior in.

const TAG = `lic-sync-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = { adminId: string; employeeId: string; adminToken: string };
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: role === "admin" ? "Admin" : "Officer",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function postLicense(body: Record<string, unknown>) {
  return request(app).post("/api/licenses").set(authed(ctx.adminToken)).send(body);
}

async function readSnapshot() {
  const [emp] = await db
    .select({
      siaLicenseNumber: employeesTable.siaLicenseNumber,
      siaLicenseLevel: employeesTable.siaLicenseLevel,
      siaLicenseExpiry: employeesTable.siaLicenseExpiry,
    })
    .from(employeesTable)
    .where(eq(employeesTable.userId, ctx.employeeId));
  return emp;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.employeeId = await makeUser("employee", "emp");
  // Every user has an employees row in production (boot backfill); create one
  // explicitly here so the mirror UPDATE has a target.
  await db.insert(employeesTable).values({ userId: ctx.employeeId, position: "officer" });
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM licenses WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("license create/edit mirrors the active license onto the employee profile", () => {
  it("uploading a license populates the employees siaLicense* snapshot", async () => {
    const res = await postLicense({
      employeeId: ctx.employeeId,
      type: "SIA Door Supervisor",
      level: 2,
      licenseNumber: `${TAG}-A`,
      expiryDate: "2030-01-01",
    });
    expect(res.status).toBe(201);

    const snap = await readSnapshot();
    expect(snap.siaLicenseNumber).toBe(`${TAG}-A`);
    expect(snap.siaLicenseLevel).toBe(2);
    expect(snap.siaLicenseExpiry).toBe("2030-01-01");
  });

  it("uploading an OLDER license does not clobber the active (latest-expiry) one", async () => {
    const res = await postLicense({
      employeeId: ctx.employeeId,
      type: "SIA CCTV",
      level: 3,
      licenseNumber: `${TAG}-B`,
      expiryDate: "2028-01-01", // earlier than license A
    });
    expect(res.status).toBe(201);

    // A (2030) is still the active license, so the snapshot must stay on A.
    const snap = await readSnapshot();
    expect(snap.siaLicenseNumber).toBe(`${TAG}-A`);
    expect(snap.siaLicenseLevel).toBe(2);
    expect(snap.siaLicenseExpiry).toBe("2030-01-01");
  });

  it("uploading a later-expiry license makes it the active snapshot", async () => {
    const res = await postLicense({
      employeeId: ctx.employeeId,
      type: "SIA Close Protection",
      level: 4,
      licenseNumber: `${TAG}-C`,
      expiryDate: "2032-01-01", // latest
    });
    expect(res.status).toBe(201);

    const snap = await readSnapshot();
    expect(snap.siaLicenseNumber).toBe(`${TAG}-C`);
    expect(snap.siaLicenseLevel).toBe(4);
    expect(snap.siaLicenseExpiry).toBe("2032-01-01");
  });

  it("editing a license so it becomes the latest refreshes the snapshot", async () => {
    // Create a license, then push its expiry past the current active one.
    const created = await postLicense({
      employeeId: ctx.employeeId,
      type: "SIA CCTV",
      level: 3,
      licenseNumber: `${TAG}-D`,
      expiryDate: "2029-01-01",
    });
    expect(created.status).toBe(201);
    const licenseId = created.body.id as string;

    const edited = await request(app)
      .put(`/api/licenses/${licenseId}`)
      .set(authed(ctx.adminToken))
      .send({ licenseNumber: `${TAG}-D2`, level: 3, expiryDate: "2035-01-01" });
    expect(edited.status).toBe(200);

    const snap = await readSnapshot();
    expect(snap.siaLicenseNumber).toBe(`${TAG}-D2`);
    expect(snap.siaLicenseLevel).toBe(3);
    expect(snap.siaLicenseExpiry).toBe("2035-01-01");
  });
});
