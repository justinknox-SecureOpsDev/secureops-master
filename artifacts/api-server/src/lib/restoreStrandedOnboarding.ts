import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, usersTable, onboardingTokensTable, applicationsTable } from "@workspace/db";
import { logger } from "./logger";
import { renderOnboardingEmail, sendEmailDetailed } from "./email";
import { sendSmsToPhoneNumber } from "./sms";

const ONBOARDING_TOKEN_TTL_DAYS = 14;

// Mirror the temp-password + token generation used at final approval
// (routes/applications.ts) so a restored account is indistinguishable from a
// freshly-approved one. Kept local (not imported from the route module) to
// avoid pulling the whole route graph into a boot job.
const TEMP_PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function genTempPassword(): string {
  const buf = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += TEMP_PW_ALPHABET[buf[i]! % TEMP_PW_ALPHABET.length];
  return out;
}
function genToken(): string {
  return randomBytes(24).toString("base64url");
}
// Trusted base URL for outbound links — env-only, never request headers.
// Mirrors getTrustedBaseUrl() in routes/applications.ts.
function buildOnboardingUrl(token: string): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  const base = explicit
    ? explicit.replace(/\/+$/, "")
    : (() => {
        const d = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
        return d ? `https://${d}` : null;
      })();
  return base ? `${base}/admin-portal/onboard/${token}` : null;
}

export interface RestoreStrandedOptions {
  /**
   * When false, re-provision the account + onboarding token (so the person
   * reappears in Onboarding as "pending") but do NOT send the invite email or
   * SMS. Defaults to true. Tests pass false to avoid live SMS (which, unlike
   * email, is not environment-suppressed).
   */
  sendInvites?: boolean;
  /**
   * Restrict the repair to specific application ids. Omit to scan all stranded
   * approved applications. Used by tests to stay hermetic on the shared DB.
   */
  applicationIds?: string[];
}

export interface RestoreStrandedResult {
  restored: number;
  skipped: number;
  errors: number;
}

/**
 * One-time idempotent repair for applicants who were APPROVED (two distinct
 * admins signed off and an onboarding email was sent) but whose login account +
 * onboarding token were later deleted out from under the still-"approved"
 * application — e.g. by deleting the user row directly from the admin Users
 * table, which (unlike the dedicated "Remove from onboarding" action) left the
 * application frozen as "approved" pointing at a now-missing account. Such
 * people are invisible in the Onboarding list and cannot log in or finish
 * onboarding.
 *
 * For each stranded application this re-provisions a fresh pending account +
 * onboarding token (mirroring final approval) and — unless sendInvites=false —
 * re-sends the onboarding email + SMS so the candidate gets a working link and
 * temporary password.
 *
 * Idempotent: once an account exists for the application again the row no
 * longer matches the "account missing" filter and is skipped on later runs.
 * Seeded/test rows (…@example.com) and malformed entries with no email address
 * are always skipped.
 */
export async function restoreStrandedOnboardingApplicants(
  opts: RestoreStrandedOptions = {},
): Promise<RestoreStrandedResult> {
  const sendInvites = opts.sendInvites !== false;
  const result: RestoreStrandedResult = { restored: 0, skipped: 0, errors: 0 };

  const conditions = [
    eq(applicationsTable.status, "approved"),
    isNotNull(applicationsTable.createdEmployeeId),
    // Real applicant emails only — skip seeded/test rows (…@example.com) and
    // malformed entries with no address at all.
    sql`position('@' in ${applicationsTable.email}) > 1`,
    sql`lower(${applicationsTable.email}) NOT LIKE '%@example.com'`,
    // The account the application points at no longer exists.
    sql`NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ${applicationsTable.createdEmployeeId})`,
  ];
  if (opts.applicationIds && opts.applicationIds.length > 0) {
    conditions.push(inArray(applicationsTable.id, opts.applicationIds));
  }

  const stranded = await db.select().from(applicationsTable).where(and(...conditions));
  if (stranded.length === 0) return result;
  logger.info({ count: stranded.length, sendInvites }, "Restoring stranded onboarding applicants");

  for (const app of stranded) {
    try {
      const email = app.email.toLowerCase();
      const tempPasswordPlain = genTempPassword();
      const passwordHash = await bcrypt.hash(tempPasswordPlain, 10);
      const token = genToken();
      const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_DAYS * 86400_000);

      const outcome = await db.transaction(async (tx) => {
        // Lock the application row and re-verify it is STILL stranded inside
        // the transaction. Two app instances booting at once (e.g. the overlap
        // window during a redeploy) each pre-select the same rows; the row lock
        // serializes them and this recheck lets the loser bail out cleanly
        // instead of minting a second account + invite for the same person.
        const [locked] = await tx
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.id, app.id))
          .for("update");
        if (!locked || locked.status !== "approved" || !locked.createdEmployeeId) {
          return { kind: "already" as const };
        }
        const [accountStillExists] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.id, locked.createdEmployeeId))
          .limit(1);
        if (accountStillExists) {
          // A concurrent run already re-pointed this application at a live
          // account — nothing left to do.
          return { kind: "already" as const };
        }

        // Never reuse or overwrite an account that already owns this email: it
        // may belong to a DIFFERENT, legitimate onboarding (e.g. the person
        // re-applied and got a fresh account) or to a live staff member. Leave
        // the row stranded for manual review rather than risk clobbering that
        // flow or hijacking an account.
        const [emailOwner] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email))
          .limit(1);
        if (emailOwner) {
          return { kind: "emailTaken" as const };
        }

        // Mint a brand-new pending account + fresh onboarding token and
        // re-point the application at it.
        const [u] = await tx
          .insert(usersTable)
          .values({
            email,
            passwordHash,
            firstName: app.firstName,
            lastName: app.lastName,
            phoneNumber: app.phone,
            role: "employee",
            status: "pending",
            mustChangePassword: true,
            mustCompleteProfile: true,
            mustSignPolicies: true,
          })
          .returning();
        const userId = u!.id;
        await tx.insert(onboardingTokensTable).values({
          token,
          employeeId: userId,
          applicationId: app.id,
          expiresAt,
        });
        await tx
          .update(applicationsTable)
          .set({ createdEmployeeId: userId })
          .where(eq(applicationsTable.id, app.id));
        return { kind: "restored" as const, userId };
      });

      if (outcome.kind === "already") {
        logger.debug(
          { applicationId: app.id },
          "Stranded applicant already restored by a concurrent run — skipping",
        );
        continue;
      }
      if (outcome.kind === "emailTaken") {
        result.skipped++;
        logger.warn(
          { applicationId: app.id, email },
          "Skipped stranded applicant — email already belongs to another account; needs manual review",
        );
        continue;
      }

      result.restored++;

      if (sendInvites) {
        const onboardingUrl = buildOnboardingUrl(token);
        if (!onboardingUrl) {
          logger.warn(
            { applicationId: app.id },
            "Restored account but APP_BASE_URL/REPLIT_DOMAINS unset — no invite link sent",
          );
        } else {
          const emailMsg = renderOnboardingEmail({
            firstName: app.firstName,
            onboardingUrl,
            email: app.email,
            tempPassword: tempPasswordPlain,
          });
          const delivery = await sendEmailDetailed({
            to: app.email,
            subject: emailMsg.subject,
            text: emailMsg.text,
            html: emailMsg.html,
          });
          const now = new Date();
          await db
            .update(applicationsTable)
            .set({
              onboardingEmailStatus: delivery.status,
              onboardingEmailMessageId: delivery.messageId,
              onboardingEmailResponse: delivery.response,
              onboardingEmailError:
                delivery.status === "bounced"
                  ? `Recipient(s) rejected: ${delivery.rejected.join(", ")}${delivery.response ? ` — ${delivery.response}` : ""}`
                  : delivery.error,
              onboardingEmailAttemptedAt: now,
              onboardingEmailSentAt: delivery.ok ? now : null,
            })
            .where(eq(applicationsTable.id, app.id));

          const smsBody =
            `WCSG: Hi ${app.firstName}, your application is approved. ` +
            `Complete onboarding here (expires in 14 days): ${onboardingUrl}`;
          await sendSmsToPhoneNumber(app.phone, smsBody);
        }
      }

      logger.info(
        { applicationId: app.id, employeeId: outcome.userId, invited: sendInvites },
        "Restored stranded onboarding applicant",
      );
    } catch (err) {
      result.errors++;
      logger.error({ err, applicationId: app.id }, "Failed to restore stranded onboarding applicant");
    }
  }

  logger.info(result, "Stranded onboarding restore complete");
  return result;
}
