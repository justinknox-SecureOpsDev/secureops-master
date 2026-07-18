import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, employeesTable, passwordResetTokensTable, revokedTokensTable } from "@workspace/db";
import { requireAuth, signToken, tokenTtlSeconds } from "../middlewares/auth";
import { disconnectUser } from "../lib/wsManager";
import { normalizePhoneToE164 } from "../lib/phone";
import { UpdateMyUiPreferencesBody } from "@workspace/api-zod";
import {
  forgotPasswordEmailLimiter,
  forgotPasswordIpLimiter,
  loginEmailLimiter,
  loginIpLimiter,
  resetPasswordLimiter,
} from "../middlewares/rateLimit";
import { sendEmail, renderPasswordResetEmail, renderPasswordChangedEmail } from "../lib/email";
import { geocodeOnelineAddress } from "../lib/geocode";
import { writeEmployeeFieldChanges } from "../lib/employeeChangeLog";
import { diffHighRiskChanges, enqueueHighRiskSelfEdit } from "../lib/highRiskSelfEditAlert";
import jwt from "jsonwebtoken";
import { verifyTotpOrRecovery } from "./totp";

// Short-lived bearer used between /auth/login (1st factor) and
// /auth/login-totp (2nd factor). Signed with the same SESSION_SECRET as
// the main auth tokens but scoped via `purpose:"totp-challenge"` and a
// 5 minute TTL so it cannot be used as a real session token.
const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60;
function signTotpChallenge(userId: string): string {
  const secret = process.env.SESSION_SECRET || "fallback-secret-change-me";
  return jwt.sign({ userId, purpose: "totp-challenge" }, secret, { expiresIn: TOTP_CHALLENGE_TTL_SECONDS });
}
function verifyTotpChallenge(token: string): { userId: string } | null {
  try {
    const secret = process.env.SESSION_SECRET || "fallback-secret-change-me";
    const decoded = jwt.verify(token, secret) as { userId?: string; purpose?: string };
    if (decoded.purpose !== "totp-challenge" || !decoded.userId) return null;
    return { userId: decoded.userId };
  } catch {
    return null;
  }
}

function getRequestIp(req: import("express").Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.ip || null;
}

function sendPasswordChangedNotice(
  req: import("express").Request,
  user: { id: string; email: string; firstName: string },
  changeType: "reset" | "change",
): void {
  const ip = getRequestIp(req);
  const ua = (req.headers["user-agent"] as string | undefined) || null;
  const msg = renderPasswordChangedEmail({
    firstName: user.firstName,
    changeType,
    whenIso: new Date().toISOString(),
    ip,
    userAgent: ua,
  });
  // Fire-and-forget: don't block the response on SMTP. Failures are
  // logged so admins can investigate, but the password change itself
  // has already succeeded.
  void sendEmail({ to: user.email, subject: msg.subject, text: msg.text, html: msg.html })
    .then((sent) => {
      if (sent) {
        req.log.info({ userId: user.id, changeType }, "Password change notification email sent");
      } else {
        req.log.warn({ userId: user.id, changeType }, "Password change notification email NOT sent (SMTP unconfigured or failed)");
      }
    })
    .catch((err) => {
      req.log.error({ err, userId: user.id, changeType }, "Password change notification email threw");
    });
}

const PASSWORD_RESET_TTL_MINUTES = 60;

function genResetToken(): string {
  return randomBytes(24).toString("base64url");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

/**
 * Build a password reset URL from a TRUSTED, server-configured origin only.
 *
 * Security: never derive the host/proto for security-sensitive links from
 * request headers (Host, X-Forwarded-Host, X-Forwarded-Proto). Those are
 * attacker-influenced and would let a hostile caller send a victim a
 * reset email pointing to an attacker-controlled domain that captures
 * the live token.
 *
 * Resolution order:
 *   1. APP_BASE_URL — explicit operator-configured origin (preferred).
 *   2. REPLIT_DOMAINS — first comma-separated value, used over HTTPS
 *      (Replit-managed development & deploy domain — trusted infra).
 *
 * Returns null if neither is set. In that case, callers MUST treat email
 * as having failed and MUST NOT fall back to request headers.
 */
function getTrustedBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  return null;
}

function buildResetUrl(token: string): string | null {
  const base = getTrustedBaseUrl();
  if (!base) return null;
  return `${base}/admin-portal/reset-password/${token}`;
}

const router: IRouter = Router();

function userPayload(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    mustCompleteProfile: user.mustCompleteProfile,
    createdAt: user.createdAt,
    uiPreferences: user.uiPreferences ?? undefined,
  };
}

router.post("/auth/login", loginIpLimiter, loginEmailLimiter, async (req, res): Promise<void> => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Bad Request", message: "Email and password required" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  if (!user) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }
  // Only active accounts may receive a session token. Pending accounts have
  // not yet completed onboarding (done via a separate token-based flow), and
  // inactive accounts have been intentionally deactivated. Returning a generic
  // 401 avoids leaking the specific account state to the caller.
  if (user.status !== "active") {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }
  // Two-factor gate: if the account has TOTP enrolled, do NOT issue a
  // session token. Return a short-lived challenge token instead; the
  // client must complete /auth/login-totp before getting a real session.
  if (user.totpEnrolledAt) {
    const challengeToken = signTotpChallenge(user.id);
    res.json({ needsTotp: true, challengeToken });
    return;
  }
  const token = signToken({ userId: user.id, email: user.email, role: user.role });
  await stampLogin(user.id, user.firstLoginAt);
  res.json({ token, user: userPayload(user) });
});

// Best-effort: stamp first-login (sticky) + last-login on every successful
// password auth. Fire-and-forget so a transient DB error never blocks
// returning a session to the caller.
async function stampLogin(userId: string, existingFirstLoginAt: Date | null): Promise<void> {
  const now = new Date();
  try {
    await db.update(usersTable)
      .set(existingFirstLoginAt ? { lastLoginAt: now } : { firstLoginAt: now, lastLoginAt: now })
      .where(eq(usersTable.id, userId));
  } catch {
    // intentionally swallowed — login should still succeed.
  }
}

// Second factor: exchange a valid challenge token + TOTP/recovery code for
// a real session. Rate-limited identically to /auth/login by IP to slow
// brute-force of the 6-digit window.
router.post("/auth/login-totp", loginIpLimiter, async (req, res): Promise<void> => {
  const { challengeToken, code } = req.body ?? {};
  if (typeof challengeToken !== "string" || typeof code !== "string") {
    res.status(400).json({ error: "Bad Request", message: "challengeToken and code required" });
    return;
  }
  const challenge = verifyTotpChallenge(challengeToken);
  if (!challenge) {
    res.status(401).json({ error: "Unauthorized", message: "Challenge expired. Sign in again." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, challenge.userId));
  if (!user || user.status !== "active" || !user.totpEnrolledAt) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    return;
  }
  const ok = await verifyTotpOrRecovery(user.id, code);
  if (!ok) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid code" });
    return;
  }
  const token = signToken({ userId: user.id, email: user.email, role: user.role });
  await stampLogin(user.id, user.firstLoginAt);
  res.json({ token, user: userPayload(user), via: ok });
});

// Best-effort revoke the bearer's jti so the token cannot be reused even if it
// remains in client storage / a stolen device. Always responds 200 to avoid
// leaking auth state to unauthenticated callers.
router.post("/auth/logout", async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const jwtMod = await import("jsonwebtoken");
      const decoded = jwtMod.default.decode(authHeader.slice(7)) as
        | { jti?: string; userId?: string; exp?: number }
        | null;
      if (decoded?.jti && decoded.userId) {
        const expiresAt = new Date((decoded.exp ?? Math.floor(Date.now() / 1000) + tokenTtlSeconds()) * 1000);
        await db
          .insert(revokedTokensTable)
          .values({ jti: decoded.jti, userId: decoded.userId, reason: "logout", expiresAt })
          .onConflictDoNothing();
      }
    } catch (err) {
      req.log.warn({ err }, "Logout revoke failed (token unparseable)");
    }
  }
  res.json({ success: true });
});

// Authenticated "log out from all devices" — bumps the user's
// tokens_valid_after watermark so every existing JWT is rejected.
router.post("/auth/logout-all", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  // Floor to second precision for consistency with JWT iat granularity.
  const logoutAll = new Date(Math.floor(Date.now() / 1000) * 1000);
  await db.update(usersTable).set({ tokensValidAfter: logoutAll }).where(eq(usersTable.id, userId));
  // Force-close open WebSocket sessions so the user is cut off in real time
  // rather than continuing to receive broadcasts until token expiry.
  disconnectUser(userId);
  res.json({ success: true });
});

router.post("/auth/push-token", requireAuth, async (req, res): Promise<void> => {
  const { token } = req.body as { token: string };
  if (!token) { res.status(400).json({ error: "Bad Request", message: "token required" }); return; }
  await db.update(usersTable).set({ expoPushToken: token }).where(eq(usersTable.id, req.user!.userId));
  res.json({ success: true });
});

// Per-user UI personalization (portal nav group order). Cosmetic only —
// stored on the caller's own row, never used for authorization.
router.put("/me/ui-preferences", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateMyUiPreferencesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const [current] = await db
    .select({ uiPreferences: usersTable.uiPreferences })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId));
  if (!current) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  const merged: { navGroupOrder?: string[] } = { ...(current.uiPreferences ?? {}) };
  if (parsed.data.navGroupOrder !== undefined) {
    // Dedupe while preserving first occurrence order.
    merged.navGroupOrder = [...new Set(parsed.data.navGroupOrder)];
  }
  await db.update(usersTable).set({ uiPreferences: merged }).where(eq(usersTable.id, req.user!.userId));
  res.json(merged);
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));
  if (!user) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  res.json(userPayload(user));
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/auth/change-password", requireAuth, async (req, res): Promise<void> => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));
  if (!user) {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Unauthorized", message: "Current password is incorrect" });
    return;
  }
  if (currentPassword === newPassword) {
    res.status(400).json({ error: "Bad Request", message: "New password must be different from current password" });
    return;
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  // Floor to second precision: JWT `iat` is second-granular, so using a
  // millisecond-precise timestamp would cause the brand-new token (whose
  // iat*1000 == the floor) to fail the iatMs < tokensValidAfter check.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const [updated] = await db.update(usersTable)
    .set({ passwordHash, mustChangePassword: false, tokensValidAfter: now })
    .where(eq(usersTable.id, user.id))
    .returning();
  // Rotate session: issue a fresh token (iat >= tokensValidAfter so it is
  // accepted), then disconnect any existing WebSocket sessions so they cannot
  // continue receiving broadcasts with a credential that is now invalidated.
  const token = signToken({ userId: updated.id, email: updated.email, role: updated.role });
  disconnectUser(updated.id);
  sendPasswordChangedNotice(req, updated, "change");
  res.json({ token, user: userPayload(updated) });
});

// ---- Password reset (forgot password) -----------------------------------

const ForgotPasswordBody = z.object({ email: z.string().min(1) });

// Public endpoint — returns a CONSTANT response for every input/outcome to
// prevent (a) account enumeration via response shape and (b) any chance of
// the live reset token leaking to an unauthenticated caller if email
// delivery fails in production. Real result (sent, no-such-email, smtp
// failure, dev-only reset URL) goes to server logs only.
router.post("/auth/forgot-password", forgotPasswordIpLimiter, forgotPasswordEmailLimiter, async (req, res): Promise<void> => {
  const parsed = ForgotPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: "Email required" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  // Send the constant response immediately so timing differences between
  // "user found" and "user not found" can't be used to enumerate accounts.
  res.json({ ok: true });

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user) {
      req.log.info({ email }, "Password reset requested for unknown email — silently ignored");
      return;
    }

    // Invalidate any prior unconsumed tokens for this user.
    await db.update(passwordResetTokensTable)
      .set({ consumedAt: new Date() })
      .where(and(
        eq(passwordResetTokensTable.userId, user.id),
        sql`${passwordResetTokensTable.consumedAt} IS NULL`,
      ));

    const token = genResetToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
    await db.insert(passwordResetTokensTable).values({
      token,
      userId: user.id,
      expiresAt,
      requestIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null,
    });

    const resetUrl = buildResetUrl(token);
    if (!resetUrl) {
      // Fail closed: without a trusted configured origin we refuse to send
      // a reset email at all. (Never fall back to request headers — that
      // would re-introduce the host-injection vector.)
      req.log.error({ userId: user.id }, "Password reset link could NOT be built — set APP_BASE_URL (or REPLIT_DOMAINS) so reset emails point to a trusted origin");
      return;
    }
    const msg = renderPasswordResetEmail({
      firstName: user.firstName,
      resetUrl,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
    const emailSent = await sendEmail({ to: user.email, subject: msg.subject, text: msg.text, html: msg.html });
    if (emailSent) {
      req.log.info({ userId: user.id }, "Password reset email sent");
    } else if (process.env.NODE_ENV !== "production") {
      // Dev-only convenience: print the link to the server log when SMTP
      // isn't configured. NEVER returned in the HTTP response, and never
      // logged in production where SMTP is required.
      req.log.warn({ userId: user.id, resetUrl }, "Password reset email NOT sent (no SMTP) — link logged for local dev only");
    } else {
      req.log.error({ userId: user.id }, "Password reset email failed to send (SMTP error or unconfigured in production)");
    }
  } catch (err) {
    req.log.error({ err, email }, "Password reset background work failed");
  }
});

router.get("/auth/reset-password/:token", async (req, res): Promise<void> => {
  const token = req.params.token;
  const [t] = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.token, token)).limit(1);
  if (!t) { res.status(404).json({ error: "Not Found", message: "Invalid reset link" }); return; }
  if (t.consumedAt) { res.status(404).json({ error: "Not Found", message: "This reset link has already been used" }); return; }
  if (t.expiresAt.getTime() < Date.now()) { res.status(404).json({ error: "Not Found", message: "This reset link has expired" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, t.userId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Account not found" }); return; }
  res.json({
    email: maskEmail(user.email),
    firstName: user.firstName,
    expiresAt: t.expiresAt.toISOString(),
  });
});

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/auth/reset-password", resetPasswordLimiter, async (req, res): Promise<void> => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { token, newPassword } = parsed.data;

  const [t] = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.token, token)).limit(1);
  if (!t) { res.status(404).json({ error: "Not Found", message: "Invalid reset link" }); return; }
  if (t.consumedAt) { res.status(404).json({ error: "Not Found", message: "This reset link has already been used" }); return; }
  if (t.expiresAt.getTime() < Date.now()) { res.status(404).json({ error: "Not Found", message: "This reset link has expired" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, t.userId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Account not found" }); return; }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const consumedAt = new Date();
  // Floor to second precision so the watermark does not exceed the new token's
  // iat*1000 (JWT iat is second-granular; a sub-second tokensValidAfter would
  // cause the brand-new token to be immediately rejected by requireAuth).
  const tokensValidAfterReset = new Date(Math.floor(consumedAt.getTime() / 1000) * 1000);
  const result = await db.transaction(async (tx) => {
    // Atomically consume the token. If another request beat us to it, abort.
    const consumed = await tx.update(passwordResetTokensTable)
      .set({ consumedAt })
      .where(and(
        eq(passwordResetTokensTable.id, t.id),
        sql`${passwordResetTokensTable.consumedAt} IS NULL`,
      ))
      .returning();
    if (consumed.length === 0) return { conflict: true } as const;

    // Bump tokensValidAfter so every pre-reset JWT is instantly rejected on
    // the next HTTP request or WS upgrade attempt.
    const [updated] = await tx.update(usersTable)
      .set({ passwordHash, mustChangePassword: false, tokensValidAfter: tokensValidAfterReset })
      .where(eq(usersTable.id, user.id))
      .returning();
    return { updated } as const;
  });

  if ("conflict" in result) {
    res.status(404).json({ error: "Not Found", message: "This reset link has already been used" });
    return;
  }

  const updated = result.updated;
  // Issue fresh token (iat >= tokensValidAfter), then force-close any open
  // WebSocket sessions that are still holding the now-invalidated credentials.
  const newToken = signToken({ userId: updated.id, email: updated.email, role: updated.role });
  disconnectUser(updated.id);
  req.log.info({ userId: updated.id }, "Password reset completed");
  sendPasswordChangedNotice(req, updated, "reset");
  res.json({ token: newToken, user: userPayload(updated) });
});

// Self-service profile edit. Strict allow-list of editable employee-row
// fields. Email, name, role, status, hourlyRate, license info, and any
// user-account field are intentionally NOT editable here — those must go
// through admin / HR.
const ObjectKey = z.string().min(1).max(512).startsWith("/objects/");
const PatchMeEmployeeBody = z.object({
  phone: z.string().optional(),
  address: z.string().optional(),
  // Personal details — employee-owned PII the officer may self-maintain.
  // dateOfBirth maps to a pg `date` column (ISO YYYY-MM-DD); "" is treated as an
  // explicit clear in the handler below. niNumber (SSN last 4), rightToWorkStatus
  // and directDepositConsent are compliance/financial-sensitive and fire a
  // same-day HR alert on change (see HIGH_RISK_SELF_EDIT_FIELDS).
  dateOfBirth: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).nullable().optional(),
  cityOfBirth: z.string().max(120).nullable().optional(),
  stateOfBirth: z.string().max(120).nullable().optional(),
  niNumber: z.string().max(64).nullable().optional(),
  rightToWorkStatus: z.string().max(120).nullable().optional(),
  taxCode: z.string().max(64).nullable().optional(),
  directDepositConsent: z.boolean().nullable().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactRelationship: z.string().nullable().optional(),
  emergencyContactPhone: z.string().optional(),
  uniformShirt: z.string().nullable().optional(),
  uniformTrousers: z.string().nullable().optional(),
  uniformJacket: z.string().nullable().optional(),
  uniformBoots: z.string().nullable().optional(),
  bankAccountName: z.string().nullable().optional(),
  bankAccountNumber: z.string().nullable().optional(),
  bankBsb: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
  // Self-service document refresh (Task #31). Object paths look like
  // "/objects/<uuid>" — the value the presigned-upload flow returns.
  // We enforce that prefix so officers cannot persist arbitrary strings
  // as document references. License number / level / expiry still require
  // admin (compliance-verified eligibility inputs). Officers can only swap
  // the *file* they previously uploaded. NOTE: right-to-work *status* IS now
  // self-editable above (treated as self-attested, not HR-verified — it fires
  // a same-day HR alert for re-verification via HIGH_RISK_SELF_EDIT_FIELDS).
  photoKey: ObjectKey.nullable().optional(),
  cvKey: ObjectKey.nullable().optional(),
  licenseDocKey: ObjectKey.nullable().optional(),
  passportDocKey: ObjectKey.nullable().optional(),
  rightToWorkDocKey: ObjectKey.nullable().optional(),
  trainingCertificateKeys: z.array(ObjectKey).max(50).nullable().optional(),
  // Work history — editable by the officer so they can keep their profile
  // current without an admin round-trip. Not high-risk (no financial / safety
  // consequence) so no HR alert is triggered for these fields.
  previousExperience: z.string().max(4000).nullable().optional(),
  yearsExperience: z.number().int().min(0).max(99).nullable().optional(),
  // References: max 10 entries, each with a required name. phone/relationship
  // are optional so officers can add what they know without full details.
  references: z.array(z.object({
    name: z.string().min(1).max(200),
    relationship: z.string().max(200).optional(),
    phone: z.string().max(50).optional(),
  })).max(10).nullable().optional(),
}).strict();

router.patch("/me/employee", requireAuth, async (req, res): Promise<void> => {
  const parsed = PatchMeEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No editable fields provided" });
    return;
  }
  // Normalize officer-entered phone numbers to E.164 (same default-to-US rule
  // as the public flows) so a self-service profile edit never stores an
  // un-prefixed number the SMS pipeline can't dispatch to. A provided-but-empty
  // (or whitespace) value is treated as an explicit clear -> null so both
  // columns stay consistent rather than persisting a junk blank string.
  const mutableUpdates = updates as Record<string, unknown>;
  if (Object.hasOwn(updates, "phone")) {
    const raw = updates.phone;
    if (typeof raw === "string" && raw.trim()) {
      const norm = normalizePhoneToE164(raw);
      if (!norm) {
        res.status(400).json({ error: "Bad Request", message: "Phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678)." });
        return;
      }
      mutableUpdates.phone = norm;
    } else {
      mutableUpdates.phone = null;
    }
  }
  if (Object.hasOwn(updates, "emergencyContactPhone")) {
    const raw = updates.emergencyContactPhone;
    if (typeof raw === "string" && raw.trim()) {
      const norm = normalizePhoneToE164(raw);
      if (!norm) {
        res.status(400).json({ error: "Bad Request", message: "Emergency contact phone is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678)." });
        return;
      }
      mutableUpdates.emergencyContactPhone = norm;
    } else {
      mutableUpdates.emergencyContactPhone = null;
    }
  }
  // Normalize date of birth: an empty/whitespace value clears it (null), and any
  // provided value must be a real calendar date in YYYY-MM-DD form. We round-trip
  // through Date so impossible dates (e.g. 2026-02-30) are rejected with a 400
  // instead of blowing up the pg `date` cast with a 500.
  if (Object.hasOwn(updates, "dateOfBirth")) {
    const raw = updates.dateOfBirth;
    if (typeof raw === "string" && raw.trim()) {
      const d = raw.trim();
      const dt = new Date(`${d}T00:00:00Z`);
      if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) {
        res.status(400).json({ error: "Bad Request", message: "Date of birth must be a valid date in YYYY-MM-DD format." });
        return;
      }
      mutableUpdates.dateOfBirth = d;
    } else {
      mutableUpdates.dateOfBirth = null;
    }
  }
  const userId = req.user!.userId;
  // Make sure the user behind the JWT still exists. If not, surface a clear
  // 401 so the mobile app can prompt re-login instead of looping on the form.
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Unauthorized", message: "Your session is no longer valid. Please sign in again." });
    return;
  }
  // Ownership check: document keys must be under the caller's own upload
  // prefix. The authenticated upload endpoint (/storage/uploads/request-url)
  // mints paths at /objects/uploads/u/<userId>/<uuid>, so a legitimately
  // self-uploaded file always satisfies this prefix. Rejecting any other
  // prefix prevents an attacker from planting a foreign object path (e.g.
  // another user's private document) into their own employee record and then
  // redeeming a signed download URL for it via /me/storage/sign.
  const ownedUploadPrefix = `/objects/uploads/u/${userId}/`;
  const scalarDocFields = ["photoKey", "cvKey", "licenseDocKey", "passportDocKey", "rightToWorkDocKey"] as const;
  for (const field of scalarDocFields) {
    const val = updates[field];
    if (val != null && !val.startsWith(ownedUploadPrefix)) {
      res.status(403).json({ error: "Forbidden", message: "Document key does not belong to your upload space." });
      return;
    }
  }
  if (updates.trainingCertificateKeys != null) {
    for (const k of updates.trainingCertificateKeys) {
      if (!k.startsWith(ownedUploadPrefix)) {
        res.status(403).json({ error: "Forbidden", message: "Document key does not belong to your upload space." });
        return;
      }
    }
  }
  // Auto-create the employee profile row on first save. Admin users (and any
  // legacy users that pre-date the employees-row backfill) don't necessarily
  // have a row yet; the user is authenticated and the row is keyed by userId,
  // so an upsert is always safe and avoids confusing "profile not found"
  // errors when the user is clearly logged in.
  const [existing] = await db.select().from(employeesTable).where(eq(employeesTable.userId, userId)).limit(1);
  if (!existing) {
    await db.insert(employeesTable).values({ userId, ...updates });
  } else {
    await db.update(employeesTable).set(updates).where(eq(employeesTable.userId, userId));
  }
  // Clear must-complete-profile once they've saved their profile, and mirror
  // any phone edit onto the account record so `users.phoneNumber` (the SMS
  // source of truth + account-profile display) stays in sync with the employee
  // file. Without this, an officer updating their phone here stays unreachable
  // by SMS.
  const userPatch: Record<string, unknown> = { mustCompleteProfile: false };
  if (Object.hasOwn(updates, "phone")) userPatch.phoneNumber = mutableUpdates.phone ?? null;
  await db.update(usersTable).set(userPatch).where(eq(usersTable.id, userId));
  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.userId, userId)).limit(1);

  // Best-effort background re-geocode of the home address. Fires only when
  // the address text actually changed since the last geocode (or there are
  // no coords on file). Powers the mobile open-shifts "distance from your
  // home" sort + the 50mi confirm prompt. Kill-switched by GEOCODING_ENABLED
  // because home addresses are PII sent to the US Census geocoder.
  const beforeAddr = (existing as any)?.lastGeocodedAddress ?? null;
  const beforeLat = (existing as any)?.homeLat ?? null;
  const newAddr = (employee as any)?.address as string | null | undefined;
  if (
    process.env.GEOCODING_ENABLED === "true" &&
    newAddr && newAddr.trim() &&
    (beforeLat == null || newAddr !== beforeAddr)
  ) {
    void (async () => {
      try {
        const result = await geocodeOnelineAddress(newAddr);
        if (!result) {
          req.log.info({ userId }, "Geocode: no match for employee home address");
          await db.update(employeesTable)
            .set({ lastGeocodedAddress: newAddr })
            .where(eq(employeesTable.userId, userId));
          return;
        }
        await db.update(employeesTable).set({
          homeLat: String(result.lat),
          homeLng: String(result.lng),
          lastGeocodedAddress: newAddr,
        }).where(eq(employeesTable.userId, userId));
      } catch (err) {
        req.log.error({ err, userId }, "Background employee home geocode failed");
      }
    })();
  }

  // Mirror the change-log + high-risk self-edit alert from PUT /employees/:id.
  // This is the path the mobile app actually uses for banking and emergency-
  // contact self-edits, so the alert has to be wired here too — otherwise
  // the most important real-world trigger (an officer changing their bank
  // account from the field) would never reach admins.
  const changedKeys = Object.keys(updates);
  await writeEmployeeFieldChanges({
    employeeUserId: userId,
    keys: changedKeys,
    before: existing as Record<string, unknown> | undefined,
    after: employee as Record<string, unknown> | undefined,
    actor: { userId, email: user.email, role: user.role },
    log: req.log,
  });
  const highRiskChanged = diffHighRiskChanges(
    changedKeys,
    existing as Record<string, unknown> | null | undefined,
    employee as Record<string, unknown> | null | undefined,
  );
  if (highRiskChanged.length > 0) {
    void enqueueHighRiskSelfEdit({
      employeeUserId: userId,
      changedFields: highRiskChanged,
      log: req.log,
    });
  }

  // Surface the alert flag in the response so the mobile UI can render a
  // post-save confirmation toast ("HR was notified of this change") only
  // when an alert actually fired, not on every profile save.
  res.json({ ...employee, hrNotified: highRiskChanged.length > 0, hrNotifiedFields: highRiskChanged });
});

export default router;
