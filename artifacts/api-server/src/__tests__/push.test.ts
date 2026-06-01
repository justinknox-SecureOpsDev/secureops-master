import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { Expo } from "expo-server-sdk";
import { db, usersTable, notificationsTable } from "@workspace/db";
import { sendPushToUsers } from "../lib/push";

const TAG = `push-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

// A syntactically valid Expo push token. Expo.isExpoPushToken accepts the
// ExponentPushToken[...] / ExpoPushToken[...] forms; anything else is
// treated as opt-out and never dispatched.
const VALID_EXPO_TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

type User = { id: string };

const ctx = {} as {
  withToken: User; // valid Expo token → should be dispatched
  withBadToken: User; // garbage token → filtered out, never dispatched
  noToken: User; // null token (opt-out) → never dispatched
};

async function makeUser(suffix: string, expoPushToken: string | null): Promise<User> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
      expoPushToken,
    })
    .returning({ id: usersTable.id });
  return { id: row.id };
}

beforeAll(async () => {
  ctx.withToken = await makeUser("withtoken", VALID_EXPO_TOKEN);
  ctx.withBadToken = await makeUser("badtoken", "not-a-real-expo-token");
  ctx.noToken = await makeUser("notoken", null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.execute(sql`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

async function notificationsFor(userId: string) {
  return db
    .select({
      type: notificationsTable.type,
      title: notificationsTable.title,
      body: notificationsTable.body,
      data: notificationsTable.data,
    })
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, userId));
}

describe("sendPushToUsers — delivery + opt-out", () => {
  it("dispatches an Expo message to a user holding a valid push token", async () => {
    const sendSpy = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([]);

    await sendPushToUsers([ctx.withToken.id], {
      title: "Hello",
      body: "World",
      data: { type: "chat_message", roomId: "room-1" },
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const chunks = sendSpy.mock.calls[0][0];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      to: VALID_EXPO_TOKEN,
      title: "Hello",
      body: "World",
      data: { type: "chat_message", roomId: "room-1" },
    });
  });

  it("persists an in-app notification even for a user with no push token (opt-out still recorded)", async () => {
    const sendSpy = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([]);

    await sendPushToUsers([ctx.noToken.id], {
      title: "Missed you",
      body: "No device on file",
      data: { type: "chat_message", roomId: "room-2" },
    });

    // The notification row is the durable history; it is written regardless
    // of push eligibility.
    const rows = await notificationsFor(ctx.noToken.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "chat_message",
      title: "Missed you",
      body: "No device on file",
    });

    // Delivery is skipped — no Expo dispatch is attempted for a token-less user.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("skips delivery for a malformed (non-Expo) token but still records the notification", async () => {
    const sendSpy = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([]);

    await sendPushToUsers([ctx.withBadToken.id], {
      title: "Bad token",
      body: "Should not dispatch",
      data: { type: "chat_message", roomId: "room-3" },
    });

    const rows = await notificationsFor(ctx.withBadToken.id);
    expect(rows).toHaveLength(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("dispatches only to the valid-token recipients in a mixed batch and records all of them", async () => {
    const sendSpy = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([]);

    await sendPushToUsers(
      [ctx.withToken.id, ctx.withBadToken.id, ctx.noToken.id],
      { title: "Mixed", body: "Batch", data: { type: "chat_message" } },
    );

    // Every recipient gets a persisted notification row...
    for (const u of [ctx.withToken, ctx.withBadToken, ctx.noToken]) {
      expect(await notificationsFor(u.id)).toHaveLength(1);
    }

    // ...but only the valid-token user is actually dispatched to Expo.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const chunks = sendSpy.mock.calls[0][0];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ to: VALID_EXPO_TOKEN });
  });

  it("is a no-op for an empty recipient list", async () => {
    const sendSpy = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([]);

    await sendPushToUsers([], { title: "Nobody", body: "Nothing" });

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
