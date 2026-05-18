import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  applicationsTable,
  onboardingTokensTable,
  licensesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Tagged so cleanup is precise and won't trample real seed data.
const TAG = `apps-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  adminToken: string;
  employeeToken: string;
};
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

// Build the full SubmitApplicationBody. The public endpoint enforces all
// required fields including the I-9, SSN-card, ID, photo, CV, references
// and availability. We use the "applications/" prefix for file paths so
// isApplicationObjectPath() accepts them.
function buildApplicationBody(suffix: string) {
  const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return {
    firstName: "Jane",
    lastName: TAG,
    email: `${TAG}-${suffix}@example.test`,
    phone: "(214) 555-1234",
    address: "100 Test Way",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    dateOfBirth: "1990-01-01",
    cityOfBirth: "Dallas",
    stateOfBirth: "TX",
    niNumber: "123-45-6789",
    i9Doc: { name: "i9.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    ssnCardDoc: { name: "ssn.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    idDocType: "drivers_license" as const,
    idDoc: { name: "id.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    siaLicenseNumber: `${TAG}-SIA-${suffix}`,
    siaLicenseLevel: 3,
    siaLicenseExpiry: futureExpiry,
    previousExperience: "2 years event security",
    yearsExperience: 2,
    references: [
      { name: "Ref One", relationship: "Manager", phone: "+12145550199", email: "ref1@example.test" },
    ],
    photo: { name: "photo.jpg", objectPath: `/objects/uploads/${randomUUID()}` },
    cv: { name: "cv.pdf", objectPath: `/objects/uploads/${randomUUID()}` },
    trainingCertificates: [{ name: "cert.pdf", objectPath: `/objects/uploads/${randomUUID()}` }],
    availability: [{ day: "mon" as const, period: "morning" as const }],
  };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.employeeId = await makeUser("employee", "emp");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.employeeToken = signToken({ userId: ctx.employeeId, email: `${TAG}-emp@example.test`, role: "employee" });
});

afterAll(async () => {
  // applications -> created users via createdEmployeeId. Clean tokens and
  // licenses first (FK), then dependent users (the newly provisioned
  // applicant users get tagged with last_name=TAG via the application row).
  await db.execute(sql`DELETE FROM onboarding_tokens WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM licenses WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM applications WHERE last_name = ${TAG}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("admin application approve flow", () => {
  it("provisions user + employee + license + onboarding token, then refuses re-approve as 409", async () => {
    // Insert the application directly so we sidestep publicApplicationLimiter
    // (5/hr/IP — would flake repeated test runs).
    const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const applicantEmail = `${TAG}-applicant@example.test`;
    const [applicationRow] = await db
      .insert(applicationsTable)
      .values({
        firstName: "Jane",
        lastName: TAG,
        email: applicantEmail,
        phone: "+12145550100",
        address: "100 Test Way",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        siaLicenseNumber: `${TAG}-SIA`,
        siaLicenseLevel: 3,
        siaLicenseExpiry: futureExpiry,
        status: "under_review",
      })
      .returning({ id: applicationsTable.id });

    // ---- happy path: admin approves ----
    const res = await request(app)
      .post(`/api/admin/applications/${applicationRow.id}/approve`)
      .set(authed(ctx.adminToken))
      .send({ notes: "Looks good — onboarding link sent." });

    expect(res.status).toBe(200);
    expect(res.body.employeeId).toBeTruthy();
    expect(res.body.onboardingToken).toBeTruthy();
    expect(res.body.onboardingUrl).toMatch(/\/admin-portal\/onboard\//);
    // Temp password must be returned exactly once so the admin can share
    // it manually if SMTP is unconfigured. Must NOT be derivable from
    // applicant data (we check it's not the SSN/email/etc.).
    expect(typeof res.body.tempPassword).toBe("string");
    expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(10);
    expect(res.body.tempPassword).not.toBe("123-45-6789");

    const newUserId: string = res.body.employeeId;

    // ---- DB invariants ----
    const [newUser] = await db.select().from(usersTable).where(eq(usersTable.id, newUserId));
    expect(newUser.email).toBe(applicantEmail);
    expect(newUser.role).toBe("employee");
    expect(newUser.status).toBe("pending");
    expect(newUser.mustChangePassword).toBe(true);

    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, newUserId));
    expect(emp).toBeTruthy();
    expect(emp.applicationId).toBe(applicationRow.id);
    expect(emp.siaLicenseNumber).toBe(`${TAG}-SIA`);

    const tokens = await db
      .select()
      .from(onboardingTokensTable)
      .where(eq(onboardingTokensTable.employeeId, newUserId));
    const liveTokens = tokens.filter((t) => t.consumedAt == null);
    expect(liveTokens.length).toBe(1);
    expect(liveTokens[0].token).toBe(res.body.onboardingToken);

    const licenses = await db
      .select()
      .from(licensesTable)
      .where(eq(licensesTable.employeeId, newUserId));
    expect(licenses.length).toBe(1);
    expect(licenses[0].level).toBe(3);
    expect(licenses[0].licenseNumber).toBe(`${TAG}-SIA`);

    // Application row marked approved + linked to the new user.
    const [appAfter] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applicationRow.id));
    expect(appAfter.status).toBe("approved");
    expect(appAfter.createdEmployeeId).toBe(newUserId);
    expect(appAfter.reviewedBy).toBe(ctx.adminId);

    // ---- re-approve must be a clean 409, not a 500 ----
    const reapprove = await request(app)
      .post(`/api/admin/applications/${applicationRow.id}/approve`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(reapprove.status).toBe(409);
    expect(reapprove.body.message).toMatch(/already approved/i);
  });

  it("returns 409 when the applicant's email collides with an existing admin", async () => {
    // The email-conflict guard refuses to re-provision any user that isn't
    // an employee in pending/inactive state. Admin accounts are off limits
    // — otherwise the HR pipeline could silently overwrite an admin's
    // credentials.
    const collidingEmail = `${TAG}-admin@example.test`; // same as ctx.adminId
    const [appRow] = await db
      .insert(applicationsTable)
      .values({
        firstName: "Conflict",
        lastName: TAG,
        email: collidingEmail,
        phone: "+12145550100",
        address: "1 Conflict Way",
        status: "submitted",
      })
      .returning({ id: applicationsTable.id });

    const res = await request(app)
      .post(`/api/admin/applications/${appRow.id}/approve`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it("blocks non-admin employees from approving an application (403)", async () => {
    const [appRow] = await db
      .insert(applicationsTable)
      .values({
        firstName: "Forbidden",
        lastName: TAG,
        email: `${TAG}-forbid@example.test`,
        phone: "+12145550100",
        address: "1 Forbid Way",
        status: "submitted",
      })
      .returning({ id: applicationsTable.id });

    const res = await request(app)
      .post(`/api/admin/applications/${appRow.id}/approve`)
      .set(authed(ctx.employeeToken))
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("public application submission", () => {
  it("accepts a well-formed body and persists it (201)", async () => {
    const body = buildApplicationBody("public");
    const res = await request(app).post("/api/applications").send(body);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    // Email normalized to lowercase, phone normalized to E.164 (+1…).
    expect(res.body.email).toBe(body.email.toLowerCase());
    expect(res.body.phone).toMatch(/^\+1\d{10}$/);
  });
});
