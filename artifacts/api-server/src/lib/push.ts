import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, usersTable, notificationsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
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
 *
 * ── Category 1: live-ops / location tabs ─────────────────────────────────────
 * Tabs used in geofence, emergency, and location-context notifications.
 */
export const ADMIN_TAB_LIVE_MAP = "Live Map" as const;

/**
 * ── Category 2: action / approval tabs ───────────────────────────────────────
 * Tabs for workflow actions admins may be directed to by future notifications
 * (e.g. "Tap to review in the Approvals tab", "Check the Shifts tab").
 * Adding constants here gives future notification authors a type-safe
 * reference and keeps the cross-package tabNames test coverage complete.
 */
export const ADMIN_TAB_APPROVALS = "Approvals" as const;
export const ADMIN_TAB_SHIFTS = "Shifts" as const;
export const ADMIN_TAB_INCIDENTS = "Incidents" as const;

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
    await dispatchChunk(chunk, true);
  }
}

/** Shape of the error expo-server-sdk throws for a rejected batch. */
type ExpoSendError = { code?: string; details?: Record<string, string[]> };

/**
 * Send one chunk of push messages, with two recovery behaviors:
 *
 * 1. PUSH_TOO_MANY_EXPERIENCE_IDS — the users table can hold tokens minted by
 *    more than one Expo project at once (devices still running the retired
 *    legacy app alongside current-app installs). Expo rejects a mixed batch
 *    OUTRIGHT, which silently killed every push from this deployment. The
 *    error's `details` field maps each project to its tokens, so we split the
 *    chunk by project and resend each group separately — every device still
 *    gets its notification, whichever app it runs.
 *
 * 2. DeviceNotRegistered tickets — Expo tells us the token is permanently
 *    dead (app uninstalled / token rotated). We null it out so the row
 *    self-heals instead of polluting future batches forever.
 */
async function dispatchChunk(chunk: ExpoPushMessage[], allowSplit: boolean): Promise<void> {
  try {
    const tickets = await expo.sendPushNotificationsAsync(chunk);
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      if (ticket.status === "error") {
        logger.error({ receipt: ticket }, "Push notification error");
        const to = chunk[i]?.to;
        if (ticket.details?.error === "DeviceNotRegistered" && typeof to === "string") {
          await clearDeadPushToken(to);
        }
      }
    }
  } catch (err) {
    const e = err as ExpoSendError;
    if (allowSplit && e.code === "PUSH_TOO_MANY_EXPERIENCE_IDS" && e.details) {
      logger.warn(
        { projects: Object.keys(e.details) },
        "Push chunk mixed tokens from multiple Expo projects; splitting and resending per project",
      );
      for (const tokens of Object.values(e.details)) {
        const tokenSet = new Set(tokens);
        const sub = chunk.filter((m) => typeof m.to === "string" && tokenSet.has(m.to));
        if (sub.length) await dispatchChunk(sub, false);
      }
      return;
    }
    logger.error({ err }, "Failed to send push chunk");
  }
}

async function clearDeadPushToken(token: string): Promise<void> {
  try {
    await db
      .update(usersTable)
      .set({ expoPushToken: null })
      .where(eq(usersTable.expoPushToken, token));
    logger.info("Cleared dead push token (DeviceNotRegistered)");
  } catch (err) {
    logger.error({ err }, "Failed to clear dead push token");
  }
}
