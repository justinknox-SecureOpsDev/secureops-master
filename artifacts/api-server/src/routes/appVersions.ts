import { Router, type IRouter } from "express";
import { eq, inArray, ne } from "drizzle-orm";
import { Expo } from "expo-server-sdk";
import { db, usersTable } from "@workspace/db";
import { requireAdminOrDispatcher } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";
import { sendSmsToUsers, type SmsResult } from "../lib/sms";
import {
  CURRENT_EXPO_PROJECT_ID,
  DEFAULT_ANDROID_STORE_URL,
  DEFAULT_APP_UPDATE_MESSAGE,
  DEFAULT_IOS_STORE_URL,
  isOnCurrentApp,
  isStoreUrl,
} from "../lib/mobileApp";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * GET /admin/app-versions
 *
 * Per-employee view of which mobile app build each user last ran, for the
 * Personnel roster's "old app" filter. A user is on the current app only
 * when their install self-reported the current Expo project id —
 * never-reported users are out of date by definition (the retired legacy
 * app has no reporting code and can never check in).
 *
 * Admin/dispatcher only: this is operational device info, not something
 * site managers or clients need.
 */
router.get("/admin/app-versions", requireAdminOrDispatcher, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      appProjectId: usersTable.appProjectId,
      appVersion: usersTable.appVersion,
      appBuildNumber: usersTable.appBuildNumber,
      appPlatform: usersTable.appPlatform,
      appReportedAt: usersTable.appReportedAt,
      appUpdateNotifiedAt: usersTable.appUpdateNotifiedAt,
    })
    .from(usersTable)
    .where(ne(usersTable.role, "client"));

  res.json({
    currentProjectId: CURRENT_EXPO_PROJECT_ID,
    defaults: {
      message: DEFAULT_APP_UPDATE_MESSAGE,
      iosUrl: DEFAULT_IOS_STORE_URL,
      androidUrl: DEFAULT_ANDROID_STORE_URL,
    },
    users: rows.map((r) => ({
      ...r,
      onCurrentApp: isOnCurrentApp(r.appProjectId),
    })),
  });
});

type NoticeBody = {
  userIds?: unknown;
  message?: unknown;
  iosUrl?: unknown;
  androidUrl?: unknown;
  sendSms?: unknown;
};

/**
 * POST /admin/app-update-notice
 *
 * Sends the "install the new SecureOps app" notice to the selected users
 * through every channel the retired legacy app can still receive:
 *   - push (sendPushToUsers splits mixed-project batches, so legacy-project
 *     tokens still get the push), which ALSO persists an in-app
 *     notification row readable inside whichever app they have; and
 *   - optionally SMS (opt-in + E.164 phone required, degrades to
 *     "skipped" when Twilio is not configured).
 *
 * Stamps appUpdateNotifiedAt on every targeted user and returns a
 * per-channel summary plus who had no push token AND no reachable SMS,
 * so admins can follow up individually instead of blind-resending.
 */
router.post("/admin/app-update-notice", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as NoticeBody;
  const userIds = Array.isArray(body.userIds)
    ? (body.userIds as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const sendSms = body.sendSms === true;

  if (!userIds.length || userIds.length > 500) {
    res.status(400).json({ error: "Bad Request", message: "userIds must list 1-500 users" });
    return;
  }
  if (!message || message.length > 1000) {
    res.status(400).json({ error: "Bad Request", message: "message is required (max 1000 chars)" });
    return;
  }
  if (!isStoreUrl(body.iosUrl, "ios")) {
    res.status(400).json({ error: "Bad Request", message: "iosUrl must be an apps.apple.com link" });
    return;
  }
  if (!isStoreUrl(body.androidUrl, "android")) {
    res.status(400).json({ error: "Bad Request", message: "androidUrl must be a play.google.com link" });
    return;
  }
  const iosUrl = body.iosUrl;
  const androidUrl = body.androidUrl;

  const targets = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      expoPushToken: usersTable.expoPushToken,
      phoneNumber: usersTable.phoneNumber,
      smsOptIn: usersTable.smsOptIn,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
  const recipients = targets.filter((t) => t.role !== "client");
  if (!recipients.length) {
    res.status(400).json({ error: "Bad Request", message: "No matching users" });
    return;
  }
  const ids = recipients.map((r) => r.id);

  // Push + persisted in-app notification (one call — sendPushToUsers writes
  // the notifications rows first, so even push-dead legacy installs can
  // read the notice in their in-app notification list).
  await sendPushToUsers(ids, {
    title: "Install the new SecureOps app",
    body: message,
    data: { type: "app_update", iosUrl, androidUrl },
  });
  const pushReachable = recipients.filter(
    (r) => r.expoPushToken && Expo.isExpoPushToken(r.expoPushToken),
  ).length;

  let sms: SmsResult | null = null;
  if (sendSms) {
    sms = await sendSmsToUsers(ids, `${message}\niPhone: ${iosUrl}\nAndroid: ${androidUrl}`);
  }

  const now = new Date();
  await db.update(usersTable).set({ appUpdateNotifiedAt: now }).where(inArray(usersTable.id, ids));

  const smsReachable = (r: (typeof recipients)[number]) =>
    sendSms && !!r.smsOptIn && !!r.phoneNumber && /^\+\d{8,15}$/.test(r.phoneNumber);
  const unreachable = recipients
    .filter((r) => !(r.expoPushToken && Expo.isExpoPushToken(r.expoPushToken)) && !smsReachable(r))
    .map((r) => ({ id: r.id, firstName: r.firstName, lastName: r.lastName }));

  logger.info(
    { count: ids.length, pushReachable, sms, by: req.user!.userId },
    "App-update notice sent",
  );

  res.json({
    total: ids.length,
    inApp: ids.length,
    push: pushReachable,
    sms,
    unreachable,
    notifiedAt: now.toISOString(),
  });
});

export default router;
