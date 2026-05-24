import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, usersTable, notificationsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";

const expo = new Expo();

export async function sendPushToUsers(
  userIds: string[],
  notification: { title: string; body: string; data?: Record<string, unknown> },
) {
  if (!userIds.length) return;

  // Persist an in-app notification row for every recipient FIRST so users
  // can review their notification history later (mobile Notifications
  // screen, /me/notifications). This is independent of push delivery —
  // users without an Expo token, with revoked permissions, or whose push
  // chunk fails still see a record of what was sent to them.
  const dedupedIds = Array.from(new Set(userIds));
  const type = typeof notification.data?.type === "string" ? notification.data.type : "general";
  try {
    await db.insert(notificationsTable).values(
      dedupedIds.map((uid) => ({
        userId: uid,
        type,
        title: notification.title,
        body: notification.body,
        data: notification.data ?? null,
      })),
    );
  } catch (err) {
    logger.error({ err }, "Failed to persist notifications");
  }

  const users = await db
    .select({ id: usersTable.id, expoPushToken: usersTable.expoPushToken })
    .from(usersTable)
    .where(inArray(usersTable.id, dedupedIds));

  const messages: ExpoPushMessage[] = users
    .filter((u) => u.expoPushToken && Expo.isExpoPushToken(u.expoPushToken))
    .map((u) => ({
      to: u.expoPushToken!,
      sound: "default" as const,
      title: notification.title,
      body: notification.body,
      data: notification.data,
    }));

  if (!messages.length) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      for (const receipt of receipts) {
        if (receipt.status === "error") {
          logger.error({ receipt }, "Push notification error");
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to send push chunk");
    }
  }
}
