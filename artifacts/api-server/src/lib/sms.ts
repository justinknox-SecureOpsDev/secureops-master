/**
 * SMS delivery via Twilio (Replit connector).
 *
 * Mirrors `push.ts`: callers pass a list of internal user IDs, we look up
 * the recipients and fire SMS in parallel. Gracefully degrades to a no-op
 * (with a single info log) when:
 *   - the Twilio integration isn't connected,
 *   - the user has no phone number,
 *   - the user has opted out of SMS, or
 *   - the from-number isn't configured.
 *
 * SMS is intentionally additive: it runs alongside push, never replaces it.
 * Push remains the primary delivery channel because it's free and supports
 * rich payloads. SMS is a safety-net for high-importance alerts (emergency,
 * shift assignment, vacancy fill) when the recipient may not have the app
 * open.
 *
 * ────────────────────────────────────────────────────────────────────────
 * POLICY — DO NOT TEXT EMERGENCY CONTACTS.
 *
 * `employees.emergency_contact_phone` (and the matching column on
 * `applications` / `onboarding_submissions`) is captured for paper-trail
 * purposes only: HR or 911 dispatch can call it manually in a real
 * emergency. It is NEVER an SMS recipient.
 *
 * Emergency contacts have not consented to receive texts from WCSG. They
 * are not users of the platform, they have no opt-out mechanism, and
 * texting them would create a TCPA exposure and a privacy issue.
 *
 * Concretely:
 *   - `sendSmsToUsers` reads from `users` only — emergency-contact rows
 *     are not in `users`, so this path is structurally safe.
 *   - `sendSmsToPhoneNumber` accepts a raw number. Callers MUST only pass
 *     a number belonging to (a) the user themselves, or (b) an applicant
 *     about their own application. Passing an emergency-contact phone
 *     through this helper is forbidden — `assertNotEmergencyContactPhone`
 *     enforces it at runtime and any new caller will be caught in review.
 * ────────────────────────────────────────────────────────────────────────
 */
import { db, usersTable, employeesTable, onboardingSubmissionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { normalizePhoneToE164 } from "./phone";

/**
 * Returns true when `phone` matches an emergency-contact-of-record on any
 * employee or onboarding submission. Used as a defensive guard before any
 * one-off SMS — see the file-level POLICY block.
 *
 * (Note: the public `applications` table does not carry an emergency-
 * contact phone — that field is only persisted by the onboarding form,
 * which writes to both `onboarding_submissions` and the mirrored
 * `employees` row. Both are checked here.)
 *
 * Input is re-normalized to E.164 before comparison so callers can pass a
 * free-text number safely; every emergency-contact phone in the DB is
 * already normalized at write time (see `lib/phone.ts`).
 */
export async function isEmergencyContactPhone(phone: string): Promise<boolean> {
  const normalized = normalizePhoneToE164(phone);
  if (!normalized) return false;
  const [emp] = await db
    .select({ id: employeesTable.userId })
    .from(employeesTable)
    .where(eq(employeesTable.emergencyContactPhone, normalized))
    .limit(1);
  if (emp) return true;
  const [sub] = await db
    .select({ id: onboardingSubmissionsTable.id })
    .from(onboardingSubmissionsTable)
    .where(eq(onboardingSubmissionsTable.emergencyContactPhone, normalized))
    .limit(1);
  return Boolean(sub);
}

interface TwilioCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

let cachedCreds: TwilioCreds | null = null;
let lastFetchAt = 0;
const CRED_TTL_MS = 60_000;

/**
 * Resolve Twilio credentials from the Replit connectors proxy. Cached for
 * 60s to avoid hammering the proxy on every alert. Returns null when the
 * integration isn't connected or the from-number isn't set.
 */
async function getTwilioCreds(): Promise<TwilioCreds | null> {
  const now = Date.now();
  if (cachedCreds && now - lastFetchAt < CRED_TTL_MS) return cachedCreds;

  // Env-var fallback (preferred when explicitly set): allows operators to
  // configure Twilio without going through the Replit connector popup.
  const envSid = process.env["TWILIO_ACCOUNT_SID"]?.trim();
  const envToken = process.env["TWILIO_AUTH_TOKEN"]?.trim();
  const envFromRaw = process.env["TWILIO_PHONE_NUMBER"]?.trim();
  // Defensively normalize to E.164: strip non-digits, ensure leading "+".
  // Twilio rejects from-numbers without the "+" prefix.
  const envFrom = envFromRaw
    ? (envFromRaw.startsWith("+") ? "+" + envFromRaw.slice(1).replace(/\D/g, "") : "+" + envFromRaw.replace(/\D/g, ""))
    : undefined;
  if (envSid && envToken && envFrom && /^\+\d{8,15}$/.test(envFrom)) {
    cachedCreds = { accountSid: envSid, authToken: envToken, fromNumber: envFrom };
    lastFetchAt = now;
    return cachedCreds;
  }

  const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
  const xReplitToken = process.env["REPL_IDENTITY"]
    ? `repl ${process.env["REPL_IDENTITY"]}`
    : process.env["WEB_REPL_RENEWAL"]
      ? `depl ${process.env["WEB_REPL_RENEWAL"]}`
      : null;
  if (!hostname || !xReplitToken) return null;

  try {
    const url = `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=twilio`;
    const resp = await fetch(url, { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { items?: Array<{ settings?: Record<string, unknown> }> };
    const item = json.items?.[0];
    if (!item?.settings) return null;
    const s = item.settings;
    // Only accept non-empty primitive strings — never coerce arbitrary
    // values via String(...). A malformed connector response (null, an
    // object, a number) would otherwise become a truthy garbage string
    // like "[object Object]" and get cached as valid creds for 60s.
    const pickStr = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = s[k];
        if (typeof v === "string") {
          const t = v.trim();
          if (t.length > 0) return t;
        }
      }
      return null;
    };
    const accountSid = pickStr("account_sid", "accountSid");
    const authToken = pickStr("auth_token", "authToken");
    const fromNumber = pickStr("from_number", "fromNumber", "phone_number");
    if (!accountSid || !authToken || !fromNumber) return null;
    cachedCreds = { accountSid, authToken, fromNumber };
    lastFetchAt = now;
    return cachedCreds;
  } catch (err) {
    logger.warn({ err }, "[sms] failed to fetch Twilio credentials from connectors proxy");
    return null;
  }
}

/** Reset cached creds — useful after the connection is added/removed. */
export function clearTwilioCredsCache(): void {
  cachedCreds = null;
  lastFetchAt = 0;
}

/** True if a Twilio connection is live and ready to send. */
export async function isSmsConfigured(): Promise<boolean> {
  return (await getTwilioCreds()) !== null;
}

/**
 * Send a single SMS. Used internally by `sendSmsToUsers`; exported for
 * routes that already know the destination number (e.g. test endpoints).
 */
async function sendOne(creds: TwilioCreds, to: string, body: string): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
  const params = new URLSearchParams({ From: creds.fromNumber, To: to, Body: body });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Twilio responded ${resp.status}: ${errBody.slice(0, 200)}`);
  }
}

export interface SmsResult {
  attempted: number;
  delivered: number;
  skipped: number;
  failed: number;
}

/**
 * Send an SMS to each of the given user IDs. Body should be ≤320 chars
 * to comfortably fit two segments — we don't truncate for callers because
 * different alerts want different choices (truncate vs. URL-shorten).
 */
export async function sendSmsToUsers(userIds: string[], body: string): Promise<SmsResult> {
  const result: SmsResult = { attempted: 0, delivered: 0, skipped: 0, failed: 0 };
  if (!userIds.length) return result;

  const creds = await getTwilioCreds();
  if (!creds) {
    result.skipped = userIds.length;
    return result;
  }

  const recipients = await db
    .select({
      id: usersTable.id,
      phoneNumber: usersTable.phoneNumber,
      smsOptIn: usersTable.smsOptIn,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));

  const sendable = recipients.filter((r) => r.smsOptIn && r.phoneNumber && /^\+\d{8,15}$/.test(r.phoneNumber));
  result.attempted = sendable.length;
  result.skipped = userIds.length - sendable.length;

  await Promise.all(
    sendable.map(async (r) => {
      try {
        await sendOne(creds, r.phoneNumber!, body);
        result.delivered += 1;
      } catch (err) {
        result.failed += 1;
        logger.warn({ err, userId: r.id }, "[sms] delivery failed");
      }
    }),
  );

  return result;
}

/**
 * Send a single SMS to a raw phone number, bypassing the user-opt-in lookup.
 *
 * Used for transactional one-off messages where there's no user account yet
 * (or no opt-in flag is meaningful), e.g. texting a newly-approved applicant
 * the onboarding link as a fallback to email. The applicant explicitly gave
 * us this phone number on their application, so contacting them about that
 * application is implied-consent.
 *
 * Caller MUST pass an E.164 number (`+` followed by 8–15 digits). Returns:
 *   - `"sent"`     — SMS dispatched to Twilio successfully.
 *   - `"skipped"`  — Twilio not configured OR number is not valid E.164.
 *   - `"failed"`   — Twilio rejected the request.
 *
 * Never throws — mirrors how `push` / `sendSmsToUsers` degrade.
 */
export async function sendSmsToPhoneNumber(
  phone: string | null | undefined,
  body: string,
): Promise<"sent" | "skipped" | "failed"> {
  if (!phone || !/^\+\d{8,15}$/.test(phone)) return "skipped";

  // POLICY guard — emergency-contact numbers must never receive SMS.
  // See the file header for the full rationale. We refuse rather than
  // silently "skipped" so the failure is loud in logs if a future caller
  // accidentally pipes the wrong field through here.
  if (await isEmergencyContactPhone(phone)) {
    logger.error(
      { phoneTail: phone.slice(-4) },
      "[sms] refusing to text an emergency-contact-of-record (TCPA/consent policy)",
    );
    return "skipped";
  }

  const creds = await getTwilioCreds();
  if (!creds) return "skipped";
  try {
    await sendOne(creds, phone, body);
    return "sent";
  } catch (err) {
    logger.warn({ err }, "[sms] one-off delivery failed");
    return "failed";
  }
}
