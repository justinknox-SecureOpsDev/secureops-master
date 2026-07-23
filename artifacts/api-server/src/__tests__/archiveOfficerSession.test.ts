import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

/**
 * Confirms that archiving an officer (PUT /admin/tables/users/:id →
 * status=inactive) instantly ends their active app session: an authenticated
 * request made with a token minted BEFORE the archive is rejected 401 on the
 * very next call.
 *
 * Mechanism (settled by this test): archive does NOT bump the
 * `tokens_valid_after` revocation watermark — it only flips status to
 * "inactive". That is sufficient because `requireAuth` re-reads the live user
 * row on every request and rejects any token whose account
 * `status !== "active"` (see middlewares/auth.ts). So a live session is killed
 * the moment the row is archived, independent of the token's iat. The
 * complementary reactivation path (status → active) is the one that bumps the
 * watermark (see reactivateOfficerLogin.test.ts) so no pre-archive token can be
 * resurrected.
 */

const TAG = `archive-session-${randomUUID().slice(0, 8)}`;
const PASSWORD = "Archive123!";
const passwordHash = bcrypt.hashSync(PASSWORD, 4);
const EMAIL = `${TAG}-officer@example.test`;

type Ctx = {
  adminId: string;
  officerId: string;
  adminToken: string;
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
});

describe("archiving an officer ends their live session immediately", () => {
  let officerToken = "";

  it("issues a working session token while active", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    officerToken = res.body.token;

    // The pre-archive token works on an authenticated endpoint.
    const me = await request(app)
      .get("/api/me/totp/status")
      .set("Authorization", `Bearer ${officerToken}`);
    expect(me.status).toBe(200);
  });

  it("rejects the pre-archive token the instant the officer is archived", async () => {
    const put = await request(app)
      .put(`/api/admin/tables/users/${ctx.officerId}`)
      .set("Authorization", `Bearer ${ctx.adminToken}`)
      .send({ status: "inactive" });
    expect(put.status).toBe(200);

    // Same token that worked a moment ago is now rejected — the live status
    // check in requireAuth kills the session without waiting for expiry.
    const me = await request(app)
      .get("/api/me/totp/status")
      .set("Authorization", `Bearer ${officerToken}`);
    expect(me.status).toBe(401);

    // And a fresh login is also blocked while archived.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it("does NOT rely on a tokens_valid_after bump for archive", async () => {
    // Document/settle the mechanism: archive leaves the watermark untouched;
    // the status flip alone is what ends the session.
    const [row] = await db
      .select({ tokensValidAfter: usersTable.tokensValidAfter })
      .from(usersTable)
      .where(eq(usersTable.id, ctx.officerId))
      .limit(1);
    expect(row.tokensValidAfter.getTime()).toBe(new Date(0).getTime());
  });
});
