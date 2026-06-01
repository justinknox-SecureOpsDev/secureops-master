import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import { db, usersTable, chatRoomsTable, chatMessagesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Exercises the authorization branch on DELETE /chat/messages/:id:
//   - an officer can delete their OWN message (200) but is forbidden (403)
//     from deleting another user's message;
//   - an admin can delete ANY user's message (200);
//   - deleting a non-existent message id returns 404.
//
// Rows are tagged so cleanup scopes precisely and never trashes seed data,
// mirroring chatRoomAccess.test.ts.
const TAG = `chat-msgdel-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerAId: string;
  officerBId: string;
  adminToken: string;
  officerAToken: string;
  officerBToken: string;
  roomId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      // Epoch watermark so JWT iat (whole-second) is never < tokensValidAfter.
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function tokenFor(userId: string, role: "admin" | "employee", suffix: string): string {
  return signToken({ userId, email: `${TAG}-${suffix}@example.test`, role });
}

async function postMessage(roomId: string, userId: string, content: string): Promise<string> {
  const [row] = await db
    .insert(chatMessagesTable)
    .values({ roomId, userId, content })
    .returning({ id: chatMessagesTable.id });
  return row.id;
}

async function messageExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatMessagesTable.id })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.id, id))
    .limit(1);
  return Boolean(row);
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerAId = await makeUser("employee", "a");
  ctx.officerBId = await makeUser("employee", "b");

  ctx.adminToken = tokenFor(ctx.adminId, "admin", "admin");
  ctx.officerAToken = tokenFor(ctx.officerAId, "employee", "a");
  ctx.officerBToken = tokenFor(ctx.officerBId, "employee", "b");

  // Announcements room is visible/authorized for every authenticated user,
  // so room-level access never confounds the delete-ownership assertions.
  const [room] = await db
    .insert(chatRoomsTable)
    .values({ name: `${TAG}-announcements`, type: "announcements" })
    .returning({ id: chatRoomsTable.id });
  ctx.roomId = room.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM chat_rooms WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  // Pool closed by globalTeardown.
});

describe("DELETE /chat/messages/:id — who can delete what", () => {
  it("officer can delete their OWN message (200) and it is removed", async () => {
    const msgId = await postMessage(ctx.roomId, ctx.officerAId, "mine to delete");

    const res = await request(app)
      .delete(`/api/chat/messages/${msgId}`)
      .set(authed(ctx.officerAToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: msgId });
    expect(await messageExists(msgId)).toBe(false);
  });

  it("officer is forbidden (403) from deleting another user's message; it survives", async () => {
    const msgId = await postMessage(ctx.roomId, ctx.officerAId, "officer A's message");

    const res = await request(app)
      .delete(`/api/chat/messages/${msgId}`)
      .set(authed(ctx.officerBToken));

    expect(res.status).toBe(403);
    // The message must NOT have been deleted by the unauthorized attempt.
    expect(await messageExists(msgId)).toBe(true);
  });

  it("admin can delete ANY user's message (200) and it is removed", async () => {
    const msgId = await postMessage(ctx.roomId, ctx.officerAId, "officer A's message");

    const res = await request(app)
      .delete(`/api/chat/messages/${msgId}`)
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: msgId });
    expect(await messageExists(msgId)).toBe(false);
  });

  it("deleting a non-existent message id returns 404", async () => {
    const res = await request(app)
      .delete(`/api/chat/messages/${randomUUID()}`)
      .set(authed(ctx.adminToken));

    expect(res.status).toBe(404);
  });
});
