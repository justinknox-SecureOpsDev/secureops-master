/**
 * What the assistant says when it genuinely does not know what happened.
 *
 * These writes are not idempotent. If the dispatch to the underlying route
 * fails after the request was sent, the change may well have committed — so
 * reporting "it failed" would invite a retry that double-books or
 * double-approves. The contract proven here is: an unknown outcome comes back
 * as an explicit "I can't tell you", never as a failure, and the pending
 * action is not silently retried.
 *
 * Lives in its own file because it has to mock the dispatcher, which the main
 * assistant suite exercises for real.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable } from "@workspace/db";

// Reads still go to the real server (the approval card is rebuilt as the
// caller before executing); only the write is made to fail.
vi.mock("../lib/assistant/internalDispatch", async () => {
  const actual = await vi.importActual<typeof import("../lib/assistant/internalDispatch")>(
    "../lib/assistant/internalDispatch",
  );
  return {
    ...actual,
    dispatchAsUser: async (opts: Parameters<typeof actual.dispatchAsUser>[0]) => {
      if (opts.method === "GET") return actual.dispatchAsUser(opts);
      return {
        status: 0,
        ok: false,
        body: null,
        unconfirmed: true,
        message: actual.UNKNOWN_OUTCOME,
      };
    },
  };
});

const app = (await import("../app")).default;
const { signToken } = await import("../middlewares/auth");
const { stagePendingAction, clearPendingActionsForTests } = await import("../lib/assistant/pendingActions");
const { closeInternalDispatch } = await import("../lib/assistant/internalDispatch");

const TAG = `assistant-unconfirmed-${randomUUID().slice(0, 8)}`;

let adminId = "";
let adminToken = "";
let siteId = "";

beforeAll(async () => {
  const email = `${TAG}@example.test`;
  const [u] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: bcrypt.hashSync("test-password", 4),
      firstName: "admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  adminId = u.id;
  adminToken = signToken({ userId: u.id, email, role: "admin" });

  const [c] = await db.insert(clientsTable).values({ name: `${TAG}-client` }).returning({ id: clientsTable.id });
  const [s] = await db
    .insert(sitesTable)
    .values({
      clientId: c.id,
      name: `${TAG}-site`,
      status: "active",
      defaultPayRate: "20.00",
      defaultBillRate: "35.00",
    })
    .returning({ id: sitesTable.id });
  siteId = s.id;

  clearPendingActionsForTests();
});

afterAll(async () => {
  await closeInternalDispatch();
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("approving an action whose outcome cannot be verified", () => {
  it("answers 504 Unconfirmed instead of pretending it failed", async () => {
    const start = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    const staged = stagePendingAction({
      userId: adminId,
      tool: "create_shift",
      args: {
        siteId,
        title: `${TAG}-unverifiable`,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
      },
      summary: "Create a shift.",
      details: [],
    });

    const res = await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(504);

    expect(res.body.unconfirmed).toBe(true);
    expect(res.body.message).not.toMatch(/nothing was changed/i);
    expect(res.body.message).toMatch(/cannot tell you/i);
  });

  it("does not leave the action re-approvable, so nothing auto-retries", async () => {
    const start = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const staged = stagePendingAction({
      userId: adminId,
      tool: "create_shift",
      args: {
        siteId,
        title: `${TAG}-once-only`,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
      },
      summary: "Create a shift.",
      details: [],
    });

    await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(504);

    // The claim was consumed. A second click cannot fire a possibly-duplicate
    // write; the person is told to go and look instead.
    await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);
  });
});
