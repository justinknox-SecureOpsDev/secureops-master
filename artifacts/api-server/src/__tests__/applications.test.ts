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
  applicationAmendmentTokensTable,
  onboardingTokensTable,
  onboardingSubmissionsTable,
  licensesTable,
  policiesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Tagged so cleanup is precise and won't trample real seed data.
const TAG = `apps-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  admin2Id: string;
  employeeId: string;
  adminToken: string;
  admin2Token: string;
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
    i9: { citizenshipStatus: "citizen" as const, usedPreparer: false, attestation: true, signatureName: `Jane ${TAG}` },
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

// Insert an application row directly so we sidestep publicApplicationLimiter
// (5/hr/IP — would flake on repeated test runs). Defaults carry a TX licence
// so the onboarding-completion path can materialize a License row.
async function insertApplication(
  suffix: string,
  overrides: Partial<typeof applicationsTable.$inferInsert> = {},
): Promise<string> {
  const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [row] = await db
    .insert(applicationsTable)
    .values({
      firstName: "Jane",
      lastName: TAG,
      email: `${TAG}-${suffix}@example.test`,
      phone: "+12145550100",
      address: "100 Test Way",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      siaLicenseNumber: `${TAG}-SIA-${suffix}`,
      siaLicenseLevel: 3,
      siaLicenseExpiry: futureExpiry,
      status: "under_review",
      ...overrides,
    })
    .returning({ id: applicationsTable.id });
  return row.id;
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function approve(appId: string, token: string, body: Record<string, unknown> = {}) {
  return request(app).post(`/api/admin/applications/${appId}/approve`).set(authed(token)).send(body);
}

// Drive both approvals (two distinct admins) and return the final response.
// NOTE: this now stops at the background-check gate — nothing is provisioned.
async function approveTwice(appId: string) {
  const first = await approve(appId, ctx.adminToken, { notes: "First sign-off." });
  expect(first.status).toBe(200);
  expect(first.body.awaitingSecondApproval).toBe(true);
  const second = await approve(appId, ctx.admin2Token, { notes: "Second sign-off." });
  expect(second.status).toBe(200);
  return second;
}

function backgroundCheck(appId: string, token: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/admin/applications/${appId}/background-check`)
    .set(authed(token))
    .send(body);
}

// Full happy path: two approvals then a cleared background check, which is the
// step that actually provisions the account and issues onboarding.
async function approveAndClear(appId: string, notes = "Check came back clean.") {
  await approveTwice(appId);
  const res = await backgroundCheck(appId, ctx.adminToken, { result: "clear", notes });
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.admin2Id = await makeUser("admin", "admin2");
  ctx.employeeId = await makeUser("employee", "emp");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.admin2Token = signToken({ userId: ctx.admin2Id, email: `${TAG}-admin2@example.test`, role: "admin" });
  ctx.employeeToken = signToken({ userId: ctx.employeeId, email: `${TAG}-emp@example.test`, role: "employee" });
});

afterAll(async () => {
  // applications -> created users via createdEmployeeId. Clean dependents first
  // (FK), then the newly provisioned applicant users (tagged last_name=TAG via
  // the application row). onboarding_submissions cascade on user delete but we
  // remove them explicitly for clarity.
  await db.execute(sql`DELETE FROM onboarding_tokens WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM licenses WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM onboarding_submissions WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM application_amendment_tokens WHERE application_id IN (SELECT id FROM applications WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM applications WHERE last_name = ${TAG}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("admin application two-step approve flow", () => {
  it("first approval records the approver and provisions NOTHING", async () => {
    const appId = await insertApplication("first");

    const res = await approve(appId, ctx.adminToken, { notes: "Looks good — needs a 2nd sign-off." });
    expect(res.status).toBe(200);
    expect(res.body.awaitingSecondApproval).toBe(true);
    expect(res.body.firstApprovedBy).toBe(ctx.adminId);
    expect(res.body.application.status).toBe("awaiting_second_approval");
    // No onboarding link / temp password is issued on the first approval.
    expect(res.body.onboardingToken).toBeUndefined();
    expect(res.body.tempPassword).toBeUndefined();

    // ---- DB invariants: gate recorded, nothing provisioned ----
    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("awaiting_second_approval");
    expect(appAfter.firstApprovedBy).toBe(ctx.adminId);
    expect(appAfter.firstApprovedAt).toBeTruthy();
    expect(appAfter.secondApprovedBy).toBeNull();
    expect(appAfter.createdEmployeeId).toBeNull();

    // No user account, employee profile, license, or onboarding token yet.
    const users = await db.select().from(usersTable).where(eq(usersTable.email, `${TAG}-first@example.test`));
    expect(users.length).toBe(0);
    const tokens = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.applicationId, appId));
    expect(tokens.length).toBe(0);
  });

  it("rejects a second approval from the SAME admin (separation of duty)", async () => {
    const appId = await insertApplication("sameadmin");

    const first = await approve(appId, ctx.adminToken);
    expect(first.status).toBe(200);
    expect(first.body.awaitingSecondApproval).toBe(true);

    // Same admin tries to satisfy the gate alone — must be refused.
    const second = await approve(appId, ctx.adminToken);
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/first approval/i);

    // Still awaiting a second, distinct approver; nothing provisioned.
    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("awaiting_second_approval");
    expect(appAfter.createdEmployeeId).toBeNull();
  });

  it("second approval parks the application at the background-check gate without provisioning", async () => {
    const appId = await insertApplication("bggate");

    const res = await approveTwice(appId);
    expect(res.body.backgroundCheckPending).toBe(true);
    // Nothing is handed out at this point — no account, no onboarding link.
    expect(res.body.employeeId).toBeUndefined();
    expect(res.body.onboardingToken).toBeUndefined();
    expect(res.body.tempPassword).toBeUndefined();

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("approved");
    expect(appAfter.backgroundCheckStatus).toBe("pending");
    expect(appAfter.backgroundCheckRequestedAt).toBeTruthy();
    expect(appAfter.createdEmployeeId).toBeNull();

    const users = await db.select().from(usersTable).where(eq(usersTable.email, `${TAG}-bggate@example.test`));
    expect(users.length).toBe(0);
    const tokens = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.applicationId, appId));
    expect(tokens.length).toBe(0);

    // The approve route is closed once the gate is armed.
    const reapprove = await approve(appId, ctx.adminToken);
    expect(reapprove.status).toBe(409);
  });

  it("a failed background check holds the application: no account, no onboarding, no applicant contact", async () => {
    const appId = await insertApplication("bgfail");
    await approveTwice(appId);

    const res = await backgroundCheck(appId, ctx.adminToken, { result: "failed", notes: "Disqualifying record." });
    expect(res.status).toBe(200);
    expect(res.body.onboardingSent).toBe(false);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.backgroundCheckStatus).toBe("failed");
    expect(appAfter.backgroundCheckCompletedBy).toBe(ctx.adminId);
    expect(appAfter.backgroundCheckCompletedAt).toBeTruthy();
    expect(appAfter.backgroundCheckNotes).toBe("Disqualifying record.");
    expect(appAfter.createdEmployeeId).toBeNull();

    const users = await db.select().from(usersTable).where(eq(usersTable.email, `${TAG}-bgfail@example.test`));
    expect(users.length).toBe(0);
    const tokens = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.applicationId, appId));
    expect(tokens.length).toBe(0);
  });

  it("rejects a background-check result on an application that never reached the gate (409)", async () => {
    const appId = await insertApplication("bgungated");
    const res = await backgroundCheck(appId, ctx.adminToken, { result: "clear" });
    expect(res.status).toBe(409);
  });

  it("blocks non-admin employees from recording a background check (403)", async () => {
    const appId = await insertApplication("bgforbid");
    await approveTwice(appId);
    const res = await backgroundCheck(appId, ctx.employeeToken, { result: "clear" });
    expect(res.status).toBe(403);
  });

  it("a cleared background check creates the pending User + onboarding token, but NO Employee/License", async () => {
    const appId = await insertApplication("final");

    const res = await approveAndClear(appId);
    expect(res.body.onboardingSent).toBe(true);
    expect(res.body.employeeId).toBeTruthy();
    expect(res.body.onboardingToken).toBeTruthy();
    expect(res.body.onboardingUrl).toMatch(/\/admin-portal\/onboard\//);
    // Temp password returned once for manual sharing; must NOT be derivable
    // from applicant data.
    expect(typeof res.body.tempPassword).toBe("string");
    expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(10);
    expect(res.body.tempPassword).not.toBe("123-45-6789");

    const newUserId: string = res.body.employeeId;

    // ---- login account exists, pending, must change pw + complete profile ----
    const [newUser] = await db.select().from(usersTable).where(eq(usersTable.id, newUserId));
    expect(newUser.email).toBe(`${TAG}-final@example.test`);
    expect(newUser.role).toBe("employee");
    expect(newUser.status).toBe("pending");
    expect(newUser.mustChangePassword).toBe(true);
    expect(newUser.mustCompleteProfile).toBe(true);

    // ---- onboarding token minted and live ----
    const liveTokens = (
      await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.employeeId, newUserId))
    ).filter((t) => t.consumedAt == null);
    expect(liveTokens.length).toBe(1);
    expect(liveTokens[0].token).toBe(res.body.onboardingToken);

    // ---- CRITICAL: employee profile + license deferred to onboarding ----
    const emps = await db.select().from(employeesTable).where(eq(employeesTable.userId, newUserId));
    expect(emps.length).toBe(0);
    const licenses = await db.select().from(licensesTable).where(eq(licensesTable.employeeId, newUserId));
    expect(licenses.length).toBe(0);

    // ---- application marked approved + linked to the new user ----
    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("approved");
    expect(appAfter.createdEmployeeId).toBe(newUserId);
    expect(appAfter.firstApprovedBy).toBe(ctx.adminId);
    expect(appAfter.secondApprovedBy).toBe(ctx.admin2Id);

    // ---- re-approve after final approval must be a clean 409 ----
    const reapprove = await approve(appId, ctx.adminToken);
    expect(reapprove.status).toBe(409);
    expect(reapprove.body.message).toMatch(/already approved/i);

    // ---- re-running the background check after it cleared is refused ----
    const recheck = await backgroundCheck(appId, ctx.adminToken, { result: "clear" });
    expect(recheck.status).toBe(409);
  });

  it("request-info resets the two-admin approval gate", async () => {
    const appId = await insertApplication("reset");

    const first = await approve(appId, ctx.adminToken);
    expect(first.status).toBe(200);

    const res = await request(app)
      .post(`/api/admin/applications/${appId}/request-info`)
      .set(authed(ctx.adminToken))
      .send({ requestedFields: ["phone"], note: "Please reconfirm your phone." });
    expect(res.status).toBe(200);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("info_requested");
    expect(appAfter.firstApprovedBy).toBeNull();
    expect(appAfter.firstApprovedAt).toBeNull();
    expect(appAfter.secondApprovedBy).toBeNull();
    expect(appAfter.secondApprovedAt).toBeNull();
  });

  it("applicant amendment resets the two-admin approval gate", async () => {
    // Seed an info_requested application that (defensively) still carries stale
    // approvals, so we can prove the amend path clears all 4 columns even if
    // they were somehow non-null. Bump back to under_review on success.
    const appId = await insertApplication("amendreset", {
      status: "info_requested",
      firstApprovedBy: ctx.adminId,
      firstApprovedAt: new Date(),
      secondApprovedBy: ctx.admin2Id,
      secondApprovedAt: new Date(),
    });

    const amendToken = `${TAG}-amend-${randomUUID()}`;
    await db.insert(applicationAmendmentTokensTable).values({
      token: amendToken,
      applicationId: appId,
      requestedFields: ["phone"],
      requestedBy: ctx.adminId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .post(`/api/applications/amend/${amendToken}`)
      .send({ values: { phone: "(214) 555-0177" } });
    expect(res.status).toBe(200);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("under_review");
    expect(appAfter.firstApprovedBy).toBeNull();
    expect(appAfter.firstApprovedAt).toBeNull();
    expect(appAfter.secondApprovedBy).toBeNull();
    expect(appAfter.secondApprovedAt).toBeNull();
    // The amended field was applied + normalized to E.164.
    expect(appAfter.phone).toBe("+12145550177");

    // Token consumed so a re-submit can't double-apply.
    const [tok] = await db
      .select()
      .from(applicationAmendmentTokensTable)
      .where(eq(applicationAmendmentTokensTable.token, amendToken));
    expect(tok.consumedAt).toBeTruthy();
  });

  it("refuses to provision when applicant email collides with an existing admin (background clear)", async () => {
    // The email-conflict guard refuses to re-provision any user that isn't an
    // employee in pending/inactive state. Admin accounts are off limits. The
    // collision is checked where the account is actually provisioned, which is
    // now the cleared background check, so we seed the row already parked at
    // the gate.
    const appId = await insertApplication("collide", {
      email: `${TAG}-admin@example.test`, // collides with ctx.adminId (an admin)
      status: "approved",
      firstApprovedBy: ctx.admin2Id,
      firstApprovedAt: new Date(),
      secondApprovedBy: ctx.adminId,
      secondApprovedAt: new Date(),
      backgroundCheckStatus: "pending",
      backgroundCheckRequestedAt: new Date(),
    });

    const res = await backgroundCheck(appId, ctx.adminToken, { result: "clear" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);

    // The check must not be recorded as cleared when provisioning failed —
    // otherwise the applicant is stuck: cleared but with no account.
    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.backgroundCheckStatus).toBe("pending");
    expect(appAfter.createdEmployeeId).toBeNull();
  });

  it("blocks non-admin employees from approving an application (403)", async () => {
    const appId = await insertApplication("forbid");
    const res = await approve(appId, ctx.employeeToken);
    expect(res.status).toBe(403);
  });

  it("refuses to move an approved application back to under review (409)", async () => {
    // Direct-API guard: dropping a gated application back to "under review"
    // would strand its background-check state and re-open the approval gate.
    const appId = await insertApplication("bgreview");
    await approveTwice(appId);

    const res = await request(app)
      .post(`/api/admin/applications/${appId}/review`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(res.status).toBe(409);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.status).toBe("approved");
    expect(appAfter.backgroundCheckStatus).toBe("pending");
  });

  it("allows rejecting after a failed check, but refuses once an account exists (409)", async () => {
    // Failed check → reject is the intended close-out path.
    const failedId = await insertApplication("bgrejectfail");
    await approveTwice(failedId);
    expect((await backgroundCheck(failedId, ctx.adminToken, { result: "failed" })).status).toBe(200);
    const rejectFailed = await request(app)
      .post(`/api/admin/applications/${failedId}/reject`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(rejectFailed.status).toBe(200);

    // Provisioned → rejecting would leave a live login attached to a
    // "rejected" applicant.
    const clearedId = await insertApplication("bgrejectclear");
    await approveAndClear(clearedId);
    const rejectCleared = await request(app)
      .post(`/api/admin/applications/${clearedId}/reject`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(rejectCleared.status).toBe(409);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, clearedId));
    expect(appAfter.status).toBe("approved");
  });

  it("refuses a background report that is not from the recording admin's own upload (400)", async () => {
    const appId = await insertApplication("bgreport");
    await approveTwice(appId);

    // Another user's private-object namespace must not be stapled to the record.
    const foreign = await backgroundCheck(appId, ctx.adminToken, {
      result: "clear",
      reportKey: `/objects/uploads/u/${ctx.admin2Id}/${randomUUID()}.pdf`,
    });
    expect(foreign.status).toBe(400);

    // Anonymous application-upload namespace is equally out of bounds.
    const anon = await backgroundCheck(appId, ctx.adminToken, {
      result: "clear",
      reportKey: `/objects/uploads/${randomUUID()}`,
    });
    expect(anon.status).toBe(400);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.backgroundCheckStatus).toBe("pending");
    expect(appAfter.backgroundCheckReportKey).toBeNull();

    // The admin's own upload path is accepted and carried to the record.
    const ownKey = `/objects/uploads/u/${ctx.adminId}/${randomUUID()}.pdf`;
    const ok = await backgroundCheck(appId, ctx.adminToken, { result: "clear", reportKey: ownKey });
    expect(ok.status).toBe(200);
    const [cleared] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(cleared.backgroundCheckReportKey).toBe(ownKey);
  });

  it("a failed check can be corrected to clear, which then provisions", async () => {
    const appId = await insertApplication("bgcorrect");
    await approveTwice(appId);
    expect((await backgroundCheck(appId, ctx.adminToken, { result: "failed", notes: "Wrong record pulled." })).status).toBe(200);

    const res = await backgroundCheck(appId, ctx.admin2Token, { result: "clear", notes: "Re-run came back clean." });
    expect(res.status).toBe(200);
    expect(res.body.onboardingSent).toBe(true);

    const [appAfter] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId));
    expect(appAfter.backgroundCheckStatus).toBe("clear");
    expect(appAfter.backgroundCheckCompletedBy).toBe(ctx.admin2Id);
    expect(appAfter.backgroundCheckNotes).toBe("Re-run came back clean.");
    expect(appAfter.createdEmployeeId).toBeTruthy();
  });
});

describe("onboarding completion materializes the employee profile + license", () => {
  it("creates the Employee row and License only once onboarding is submitted", async () => {
    const appId = await insertApplication("onboard");
    const approveRes = await approveAndClear(appId);
    const newUserId: string = approveRes.body.employeeId;
    const onboardingToken: string = approveRes.body.onboardingToken;

    // Sanity: still nothing materialized right after approval.
    expect((await db.select().from(employeesTable).where(eq(employeesTable.userId, newUserId))).length).toBe(0);
    expect((await db.select().from(licensesTable).where(eq(licensesTable.employeeId, newUserId))).length).toBe(0);

    // The server requires an acknowledgement (with the exact policyId) for
    // every CURRENTLY-ACTIVE policy that has an uploaded file. Default seeded
    // policies have no fileKey and are excluded, so build acks from whatever
    // is active-for-validation right now to stay robust if a real policy file
    // exists in the shared dev DB.
    const allPolicies = await db.select().from(policiesTable);
    const activeForValidation = allPolicies.filter((p) => p.isActive && !!p.fileKey);
    const acknowledgements = activeForValidation.map((p) => ({
      type: p.slug,
      accepted: true,
      signature: `Jane ${TAG}`,
      timestamp: new Date().toISOString(),
      policyId: p.id,
      policyVersion: p.version,
    }));

    const res = await request(app)
      .post(`/api/onboarding/${onboardingToken}`)
      .send({
        bankSortCode: "021000021",
        bankAccountNumber: "123456789",
        bankAccountName: `Jane ${TAG}`,
        emergencyContactName: "Kin Person",
        emergencyContactRelationship: "Sibling",
        emergencyContactPhone: "(214) 555-0150",
        uniformShirt: "L",
        directDepositConsent: true,
        directDepositSignature: `Jane ${TAG}`,
        acknowledgements,
      });
    expect(res.status).toBe(200);

    // ---- Employee profile now exists, sourced from the application ----
    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.userId, newUserId));
    expect(emp).toBeTruthy();
    expect(emp.applicationId).toBe(appId);
    expect(emp.siaLicenseNumber).toBe(`${TAG}-SIA-onboard`);
    expect(emp.bankAccountName).toBe(`Jane ${TAG}`);
    // Emergency phone normalized to E.164 on the employee record.
    expect(emp.emergencyContactPhone).toMatch(/^\+1\d{10}$/);

    // ---- License materialized from the declared TX licence ----
    const licenses = await db.select().from(licensesTable).where(eq(licensesTable.employeeId, newUserId));
    expect(licenses.length).toBe(1);
    expect(licenses[0].level).toBe(3);
    expect(licenses[0].licenseNumber).toBe(`${TAG}-SIA-onboard`);

    // ---- user activated, onboarding token consumed ----
    const [userAfter] = await db.select().from(usersTable).where(eq(usersTable.id, newUserId));
    expect(userAfter.status).toBe("active");
    const [tok] = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.token, onboardingToken));
    expect(tok.consumedAt).toBeTruthy();

    // ---- a submission row was persisted ----
    const subs = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, newUserId));
    expect(subs.length).toBe(1);
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
