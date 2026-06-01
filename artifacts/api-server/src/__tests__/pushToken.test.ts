import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `pushtoken-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  officerId: string;
  officerToken: string;
};
const ctx = {} as Ctx;

beforeAll(async () => {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}@example.test`,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.officerId = row.id;
  ctx.officerToken = signToken({
    userId: ctx.officerId,
    email: `${TAG}@example.test`,
    role: "employee",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function readStoredToken(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ expoPushToken: usersTable.expoPushToken })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return row.expoPushToken ?? null;
}

describe("POST /auth/push-token", () => {
  it("persists an authenticated officer's posted token to users.expoPushToken", async () => {
    const token = `ExponentPushToken[${TAG}-first]`;
    const res = await request(app)
      .post("/api/auth/push-token")
      .set(authed(ctx.officerToken))
      .send({ token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await readStoredToken(ctx.officerId)).toBe(token);
  });

  it("overwrites the previously stored token when a new one is posted", async () => {
    const newToken = `ExponentPushToken[${TAG}-second]`;
    const res = await request(app)
      .post("/api/auth/push-token")
      .set(authed(ctx.officerToken))
      .send({ token: newToken });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await readStoredToken(ctx.officerId)).toBe(newToken);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app)
      .post("/api/auth/push-token")
      .send({ token: `ExponentPushToken[${TAG}-unauth]` });
    expect(res.status).toBe(401);
  });
});
