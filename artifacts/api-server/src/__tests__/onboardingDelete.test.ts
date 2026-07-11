import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  onboardingTokensTable,
  onboardingSubmissionsTable,
  applicationsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// DELETE /admin/onboarding/:employeeId — admins may remove people who are
// still in onboarding (role=employee, status=pending). Everything else is
// refused so the endpoint can never erase an active staff member.

const TAG = `onb-delete-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Made = { id: string; token: string };

async function makeUser(role: string, status: string, suffix: string): Promise<Made> {
  const email = `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: "Onb",
      lastName: TAG,
      role,
      status,
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, token: signToken({ userId: row.id, email, role }) };
}

let admin: Made;

beforeAll(async () => {
  admin = await makeUser("admin", "active", "admin");
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("DELETE /admin/onboarding/:employeeId", () => {
  it("deletes a pending employee and cascades employee row + onboarding token", async () => {
    const target = await makeUser("employee", "pending", "victim");
    await db.insert(employeesTable).values({ userId: target.id });
    await db.insert(onboardingTokensTable).values({
      token: `${TAG}-${randomUUID()}`,
      employeeId: target.id,
      expiresAt: new Date(Date.now() + 14 * 86400_000),
    });

    const res = await request(app)
      .delete(`/api/admin/onboarding/${target.id}`)
      .set(authed(admin.token));
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, target.id));
    expect(user).toBeUndefined();
    const emps = await db.select().from(employeesTable).where(eq(employeesTable.userId, target.id));
    expect(emps).toHaveLength(0);
    const toks = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.employeeId, target.id));
    expect(toks).toHaveLength(0);
    const subs = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, target.id));
    expect(subs).toHaveLength(0);
  });

  it("resets the originating application so it can be re-actioned", async () => {
    const target = await makeUser("employee", "pending", "reapply");
    const [app_] = await db
      .insert(applicationsTable)
      .values({
        status: "approved",
        firstName: "Onb",
        lastName: TAG,
        email: `${TAG}-app@example.test`,
        phone: "+15550000000",
        address: "1 Test St",
        createdEmployeeId: target.id,
        firstApprovedBy: admin.id,
        firstApprovedAt: new Date(),
        secondApprovedBy: admin.id,
        secondApprovedAt: new Date(),
        onboardingEmailStatus: "sent",
        onboardingEmailSentAt: new Date(),
      })
      .returning({ id: applicationsTable.id });

    const res = await request(app)
      .delete(`/api/admin/onboarding/${target.id}`)
      .set(authed(admin.token));
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const [after] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, app_.id));
    expect(after.status).toBe("under_review");
    expect(after.createdEmployeeId).toBeNull();
    expect(after.firstApprovedBy).toBeNull();
    expect(after.secondApprovedBy).toBeNull();
    expect(after.onboardingEmailStatus).toBeNull();
    expect(after.onboardingEmailSentAt).toBeNull();

    await db.delete(applicationsTable).where(eq(applicationsTable.id, app_.id));
  });

  it("refuses (409) for an ACTIVE employee — must go through Personnel instead", async () => {
    const active = await makeUser("employee", "active", "active");
    const res = await request(app)
      .delete(`/api/admin/onboarding/${active.id}`)
      .set(authed(admin.token));
    expect(res.status).toBe(409);
    const [still] = await db.select().from(usersTable).where(eq(usersTable.id, active.id));
    expect(still).toBeTruthy();
  });

  it("refuses (409) for non-employee roles even when status is pending", async () => {
    const staff = await makeUser("dispatcher", "pending", "dispatcher");
    const res = await request(app)
      .delete(`/api/admin/onboarding/${staff.id}`)
      .set(authed(admin.token));
    expect(res.status).toBe(409);
    const [still] = await db.select().from(usersTable).where(eq(usersTable.id, staff.id));
    expect(still).toBeTruthy();
  });

  it("404s for an unknown id", async () => {
    const res = await request(app)
      .delete(`/api/admin/onboarding/${randomUUID()}`)
      .set(authed(admin.token));
    expect(res.status).toBe(404);
  });

  it("404s (not 500) for a malformed id", async () => {
    const res = await request(app)
      .delete("/api/admin/onboarding/not-a-uuid")
      .set(authed(admin.token));
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin caller", async () => {
    const target = await makeUser("employee", "pending", "protected");
    const employee = await makeUser("employee", "active", "caller");
    const res = await request(app)
      .delete(`/api/admin/onboarding/${target.id}`)
      .set(authed(employee.token));
    expect(res.status).toBe(403);
    const [still] = await db.select().from(usersTable).where(eq(usersTable.id, target.id));
    expect(still).toBeTruthy();
  });
});
