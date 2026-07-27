import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and } from "drizzle-orm";
import { db, usersTable, onboardingTokensTable, applicationsTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { restoreStrandedOnboardingApplicants } from "../lib/restoreStrandedOnboarding";

// Applicants who were APPROVED but whose login account + onboarding token were
// later deleted out from under the still-"approved" application (e.g. via the
// generic admin Users-table delete) vanish from Onboarding and cannot log in.
// restoreStrandedOnboardingApplicants() re-provisions a fresh pending account +
// token; the Users-table delete now un-strands the application the same way the
// dedicated "Remove from onboarding" action does.
//
// sendInvites:false everywhere so no real email/SMS fires (SMS is NOT
// environment-suppressed). applicationIds scopes every scan to this test's own
// fixtures so a shared dev DB stays hermetic.

const TAG = `restore-stranded-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

let admin: { id: string; token: string };

async function makeUser(role: string, status: string, suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({ email, passwordHash, firstName: "Restore", lastName: TAG, role, status, tokensValidAfter: new Date(0) })
    .returning({ id: usersTable.id });
  return { id: row.id, token: signToken({ userId: row.id, email, role }) };
}

// Insert an APPROVED application whose createdEmployeeId points at a user that
// does not exist — i.e. exactly the stranded state the repair targets.
async function makeStrandedApp(suffix: string, emailOverride?: string): Promise<{ id: string; ghostId: string; email: string }> {
  const ghostId = randomUUID(); // no such user row
  const email = emailOverride ?? `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`;
  const [row] = await db
    .insert(applicationsTable)
    .values({
      status: "approved",
      firstName: "Restore",
      lastName: TAG,
      email,
      phone: "+15550000000",
      address: "1 Test St",
      createdEmployeeId: ghostId,
      firstApprovedBy: admin.id,
      firstApprovedAt: new Date(),
      secondApprovedBy: admin.id,
      secondApprovedAt: new Date(),
      onboardingEmailStatus: "sent",
      onboardingEmailSentAt: new Date(),
    })
    .returning({ id: applicationsTable.id });
  return { id: row.id, ghostId, email };
}

beforeAll(async () => {
  admin = await makeUser("admin", "active", "admin");
});

afterAll(async () => {
  // applications have no FK to users, so delete them explicitly; onboarding
  // tokens cascade-delete with their user.
  await db.execute(sql`DELETE FROM applications WHERE last_name = ${TAG}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("restoreStrandedOnboardingApplicants()", () => {
  it("re-provisions a fresh pending account + token and keeps the application approved", async () => {
    const stranded = await makeStrandedApp("provision");

    const result = await restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [stranded.id] });
    expect(result).toEqual({ restored: 1, skipped: 0, errors: 0 });

    // Application stays approved but now points at a real, freshly-minted account.
    const [after] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, stranded.id));
    expect(after.status).toBe("approved");
    expect(after.createdEmployeeId).toBeTruthy();
    expect(after.createdEmployeeId).not.toBe(stranded.ghostId);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, after.createdEmployeeId!));
    expect(user).toBeTruthy();
    expect(user.role).toBe("employee");
    expect(user.status).toBe("pending");
    expect(user.mustChangePassword).toBe(true);
    expect(user.email).toBe(stranded.email.toLowerCase());

    const toks = await db
      .select()
      .from(onboardingTokensTable)
      .where(and(eq(onboardingTokensTable.employeeId, after.createdEmployeeId!), eq(onboardingTokensTable.applicationId, stranded.id)));
    expect(toks).toHaveLength(1);
    expect(toks[0].consumedAt).toBeNull();
  });

  it("is idempotent — a second run restores nothing", async () => {
    const stranded = await makeStrandedApp("idempotent");

    const first = await restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [stranded.id] });
    expect(first.restored).toBe(1);

    const second = await restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [stranded.id] });
    expect(second).toEqual({ restored: 0, skipped: 0, errors: 0 });
  });

  it("skips seeded (@example.com) and email-less rows", async () => {
    const seeded = await makeStrandedApp("seeded", `${TAG}-seeded-${randomUUID().slice(0, 6)}@example.com`);
    const noEmail = await makeStrandedApp("noemail", `${TAG}-noemail-${randomUUID().slice(0, 6)}`); // no "@"

    const result = await restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [seeded.id, noEmail.id] });
    expect(result).toEqual({ restored: 0, skipped: 0, errors: 0 });

    // Both left untouched — still pointing at their (missing) ghost account.
    const [a] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, seeded.id));
    const [b] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, noEmail.id));
    expect(a.createdEmployeeId).toBe(seeded.ghostId);
    expect(b.createdEmployeeId).toBe(noEmail.ghostId);
  });

  it("skips (for manual review) when the email already belongs to another account", async () => {
    // A separate, live account already owns this email — e.g. the applicant
    // re-applied and got a fresh account after the original was deleted.
    const owner = await makeUser("employee", "pending", "collide");
    const [ownerRow] = await db.select().from(usersTable).where(eq(usersTable.id, owner.id));
    const stranded = await makeStrandedApp("collide", ownerRow.email);

    const result = await restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [stranded.id] });
    expect(result).toEqual({ restored: 0, skipped: 1, errors: 0 });

    // Application left stranded (its ghost link untouched) for an admin to handle...
    const [after] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, stranded.id));
    expect(after.createdEmployeeId).toBe(stranded.ghostId);
    // ...and the pre-existing account is not clobbered (no token minted for it).
    const toks = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.employeeId, owner.id));
    expect(toks).toHaveLength(0);
  });

  it("does not double-restore under concurrent runs (application row lock)", async () => {
    const stranded = await makeStrandedApp("concurrent");

    const [r1, r2] = await Promise.all([
      restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [stranded.id] }),
      restoreStrandedOnboardingApplicants({ sendInvites: false, applicationIds: [stranded.id] }),
    ]);

    // Exactly one of the two concurrent runs restores the applicant, with no errors...
    expect(r1.restored + r2.restored).toBe(1);
    expect(r1.errors + r2.errors).toBe(0);
    // ...and only ONE account is ever created for the email (no duplicate user).
    const users = await db.select().from(usersTable).where(eq(usersTable.email, stranded.email.toLowerCase()));
    expect(users).toHaveLength(1);
  });
});

describe("DELETE /admin/tables/users/:id un-strands the linked application", () => {
  it("resets an approved application when its user is deleted via the Users table", async () => {
    const target = await makeUser("employee", "pending", "victim");
    const [app_] = await db
      .insert(applicationsTable)
      .values({
        status: "approved",
        firstName: "Restore",
        lastName: TAG,
        email: `${TAG}-victim-${randomUUID().slice(0, 6)}@example.test`,
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

    const res = await request(app).delete(`/api/admin/tables/users/${target.id}`).set(authed(admin.token));
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, target.id));
    expect(user).toBeUndefined();

    const [after] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, app_.id));
    expect(after.status).toBe("under_review");
    expect(after.createdEmployeeId).toBeNull();
    expect(after.firstApprovedBy).toBeNull();
    expect(after.secondApprovedBy).toBeNull();
    expect(after.onboardingEmailStatus).toBeNull();
    expect(after.onboardingEmailSentAt).toBeNull();
  });
});
