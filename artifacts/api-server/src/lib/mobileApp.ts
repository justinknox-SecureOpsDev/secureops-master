/**
 * Identity of the CURRENT mobile app (the post-rebrand Expo project).
 *
 * The legacy SecureOps app was a different Expo project / bundle ID, so
 * "is this user on the current app" is decided by which project their
 * install self-reported from — not by comparing version strings. Any user
 * who has never reported (legacy app has no reporting code) or reported a
 * different project id is treated as out of date.
 *
 * Env-overridable so a forked tenant pointing at its own EAS project does
 * not need a code change.
 */
export const CURRENT_EXPO_PROJECT_ID =
  process.env.CURRENT_EXPO_PROJECT_ID ?? "e8bcd802-b11d-4c4d-bd20-5e61caf4817c";

/**
 * Default store links for the "install the new app" notice. The admin can
 * edit them before sending; validateStoreUrl keeps edits on real store hosts.
 * iOS id comes from App Store Connect (ascAppId in security-ops eas.json);
 * Android id is the app.json android.package.
 */
export const DEFAULT_IOS_STORE_URL = "https://apps.apple.com/app/id6789409652";
export const DEFAULT_ANDROID_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.secureopscommand.app";

/**
 * Default notice copy. Deliberately says "install from the store", not
 * "update" — the bundle ID changed, so the old app will never show an
 * update prompt and tapping Update in the store does nothing for it.
 */
export const DEFAULT_APP_UPDATE_MESSAGE =
  "We've moved to a new SecureOps app. Your current app is retired and will no longer receive updates — please install the new app from the store (search \"SecureOps Command\" or use the link) and sign in with your existing account.";

/**
 * True when this user's latest self-report came from the current Expo
 * project. Never-reported users (null) are out of date by definition.
 */
export function isOnCurrentApp(appProjectId: string | null | undefined): boolean {
  return appProjectId === CURRENT_EXPO_PROJECT_ID;
}

const STORE_URL_PATTERNS: Record<"ios" | "android", RegExp> = {
  ios: /^https:\/\/(apps\.apple\.com|itunes\.apple\.com)\/\S+$/i,
  android: /^https:\/\/play\.google\.com\/\S+$/i,
};

/** Loose sanity check that an edited link still points at the right store. */
export function isStoreUrl(url: unknown, platform: "ios" | "android"): url is string {
  return typeof url === "string" && url.length <= 500 && STORE_URL_PATTERNS[platform].test(url);
}
