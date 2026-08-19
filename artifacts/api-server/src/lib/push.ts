import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { db, usersTable, notificationsTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "./logger";

const expo = new Expo();

export type PushNotificationPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type InAppNotificationDelivery = {
  userIds: string[];
  notification: PushNotificationPayload;
};

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
  notification: PushNotificationPayload,
) {
  if (!userIds.length) return;

  // Persist an in-app notification row for every recipient FIRST so users
  // can review their notification history later (mobile Notifications
  // screen, /me/notifications). This is independent of push delivery —
  // users without an Expo token, with revoked permissions, or whose push
  // chunk fails still see a record of what was sent to them.
  try {
    await persistInAppNotifications([{ userIds, notification }]);
  } catch (err) {
    logger.error({ err }, "Failed to persist notifications");
  }
  await sendPushOnlyToUsers(userIds, notification);
}

/**
 * Persist a complete notification batch atomically. Unlike sendPushToUsers,
 * this deliberately throws on failure so scheduled jobs can release their
 * atomic claim and retry without silently losing the in-app alert.
 */
export async function persistInAppNotifications(deliveries: InAppNotificationDelivery[]): Promise<void> {
  const rows = deliveries.flatMap(({ userIds, notification }) => {
    const type = typeof notification.data?.type === "string" ? notification.data.type : "general";
    return Array.from(new Set(userIds)).map((userId) => ({
      userId,
      type,
      title: notification.title,
      body: notification.body,
      data: notification.data ?? null,
    }));
  });
  if (rows.length > 0) await db.insert(notificationsTable).values(rows);
}

/** Send device pushes without creating a second in-app notification row. */
export async function sendPushOnlyToUsers(
  userIds: string[],
  notification: PushNotificationPayload,
): Promise<void> {
  if (!userIds.length) return;
  const dedupedIds = Array.from(new Set(userIds));
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
      for (const [project, tokens] of Object.entries(e.details)) {
        if (!Array.isArray(tokens)) continue;
        // Label the rows that own these tokens with the project Expo says
        // minted them — this back-fills "which app is this device running"
        // for legacy-app installs that can never self-report (the retired
        // app has no reporting code). Self-reports always win.
        await labelTokensFromProjectSplit(project, tokens);
        const tokenSet = new Set(tokens);
        const sub = chunk.filter((m) => typeof m.to === "string" && tokenSet.has(m.to));
        if (sub.length) await dispatchChunk(sub, false);
      }
      return;
    }
    logger.error({ err }, "Failed to send push chunk");
  }
}

/**
 * Persist "this push token was minted by Expo project X" onto the owning
 * user rows, using the per-project token grouping from a
 * PUSH_TOO_MANY_EXPERIENCE_IDS batch split. `project` is an Expo
 * experience id (e.g. "@acct/slug"), not an EAS project UUID, so it never
 * matches CURRENT_EXPO_PROJECT_ID — which is correct: only a self-report
 * from the app itself can prove a device runs the current app. Rows that
 * have self-reported (appReportedAt set) are never overwritten.
 *
 * Exported for tests.
 */
export async function labelTokensFromProjectSplit(project: string, tokens: string[]): Promise<void> {
  const valid = tokens.filter((t) => typeof t === "string" && t.length > 0 && t.length <= 200);
  if (!valid.length) return;
  try {
    await db
      .update(usersTable)
      .set({ appProjectId: project })
      .where(and(inArray(usersTable.expoPushToken, valid), isNull(usersTable.appReportedAt)));
  } catch (err) {
    logger.error({ err, project }, "Failed to label tokens from project split");
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
