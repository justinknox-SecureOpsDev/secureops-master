import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, usersTable, notificationsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";

const expo = new Expo();

/**
 * Admin mobile tab names referenced in push-notification and SMS body strings.
 *
 * These mirror the TAB_ADMIN_* constants in
 * artifacts/security-ops/constants/tabNames.ts. They are redefined here
 * because the API server cannot import from the security-ops package.
 *
 * The tabNames Vitest suite reads this file and validates every "X tab"
 * phrase against KNOWN_TAB_PREFIXES, so any drift from the mobile layout is
 * caught before it ships.
 *
 * To rename an admin tab: update the constant in tabNames.ts (security-ops),
 * update the matching constant below, and update the admin layout title prop —
 * the test will fail until all three agree.
 */
export const ADMIN_TAB_LIVE_MAP = "Live Map" as const;

/**
 * SMS suffix appended to geofence-breach alerts, directing admins to open
 * the Live Map tab in the admin mobile app to track the officer's position.
 * Canonical wording is also exported from security-ops/constants/userCopy.ts
 * as COPY_GEOFENCE_SMS_MAP_CHECK for the mobile-side test coverage.
 */
export const SMS_GEOFENCE_MAP_PROMPT = `Check ${ADMIN_TAB_LIVE_MAP}.` as const;

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
