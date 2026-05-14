import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";

const expo = new Expo();

export async function sendPushToUsers(
  userIds: string[],
  notification: { title: string; body: string; data?: Record<string, unknown> }
) {
  if (!userIds.length) return;

  const users = await db
    .select({ id: usersTable.id, expoPushToken: usersTable.expoPushToken })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));

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
