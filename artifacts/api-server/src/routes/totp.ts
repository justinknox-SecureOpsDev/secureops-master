import { Router } from "express";
import { z } from "zod/v4";
import bcrypt from "bcryptjs";
import { generateSecret, generateURI, verifySync } from "otplib";
import qrcode from "qrcode";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { brand } from "../lib/brandConfig";

// ±1 step window — matches Google Authenticator default tolerance for
// minor clock drift between server and phone.
function checkTotp(token: string, secret: string): boolean {
  return verifySync({ token, secret, window: 1 } as never).valid;
}

const router = Router();
const ISSUER = `${brand.shortName} ${brand.appName}`;

function generateRecoveryCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i += 1) {
    // 10 hex chars, grouped 5-5 for readability — 40 bits of entropy.
    const raw = randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

async function hashCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
}

async function consumeRecoveryCode(userId: string, hashed: string[], submitted: string): Promise<string[] | null> {
  const target = submitted.trim().toUpperCase();
  for (let i = 0; i < hashed.length; i += 1) {
    if (await bcrypt.compare(target, hashed[i])) {
      const next = hashed.slice(0, i).concat(hashed.slice(i + 1));
      await db.update(usersTable).set({ totpRecoveryCodes: next }).where(eq(usersTable.id, userId));
      return next;
    }
  }
  return null;
}

// Verifies either a fresh TOTP code or a single-use recovery code. Returns
// "totp" / "recovery" on success, null on failure. On recovery success, the
// code is consumed.
export async function verifyTotpOrRecovery(userId: string, code: string): Promise<"totp" | "recovery" | null> {
  const [user] = await db
    .select({ totpSecret: usersTable.totpSecret, totpRecoveryCodes: usersTable.totpRecoveryCodes })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user?.totpSecret) return null;
  const cleaned = code.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(cleaned)) {
    if (checkTotp(cleaned, user.totpSecret)) return "totp";
  }
  const codes = user.totpRecoveryCodes ?? [];
  if (codes.length && (await consumeRecoveryCode(userId, codes, code))) return "recovery";
  return null;
}

// ---------- Status ----------
router.get("/me/totp/status", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select({ enrolledAt: usersTable.totpEnrolledAt, recovery: usersTable.totpRecoveryCodes })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId));
  res.json({
    enrolled: !!user?.enrolledAt,
    enrolledAt: user?.enrolledAt ?? null,
    recoveryCodesRemaining: user?.recovery?.length ?? 0,
  });
});

// ---------- Enroll: generate secret + QR (does NOT activate) ----------
router.post("/me/totp/enroll", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, totpEnrolledAt: usersTable.totpEnrolledAt })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId));
  if (!user) {
    res.status(404).json({ error: "Not Found" });
    return;
  }
  if (user.totpEnrolledAt) {
    res.status(409).json({ error: "Conflict", message: "Two-factor is already enabled. Disable it first." });
    return;
  }
  const secret = generateSecret();
  const otpauthUrl = generateURI({ label: user.email, issuer: ISSUER, secret });
  const qrcodeDataUri = await qrcode.toDataURL(otpauthUrl);
  // Store the candidate secret but leave totpEnrolledAt null until confirm.
  await db.update(usersTable).set({ totpSecret: secret }).where(eq(usersTable.id, user.id));
  res.json({ secret, otpauthUrl, qrcodeDataUri });
});

// ---------- Confirm enrollment ----------
const codeSchema = z.object({ code: z.string().min(6).max(20) });

router.post("/me/totp/confirm", requireAuth, async (req, res): Promise<void> => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: "code required" });
    return;
  }
  const [user] = await db
    .select({ id: usersTable.id, totpSecret: usersTable.totpSecret, totpEnrolledAt: usersTable.totpEnrolledAt })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId));
  if (!user?.totpSecret || user.totpEnrolledAt) {
    res.status(409).json({ error: "Conflict", message: "No pending enrollment" });
    return;
  }
  const cleaned = parsed.data.code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned) || !checkTotp(cleaned, user.totpSecret)) {
    res.status(400).json({ error: "Bad Request", message: "Invalid code" });
    return;
  }
  const recoveryCodes = generateRecoveryCodes();
  const hashed = await hashCodes(recoveryCodes);
  await db
    .update(usersTable)
    .set({ totpEnrolledAt: new Date(), totpRecoveryCodes: hashed })
    .where(eq(usersTable.id, user.id));
  // Recovery codes are returned ONCE — never readable again.
  res.json({ enrolled: true, recoveryCodes });
});

// ---------- Disable ----------
router.post("/me/totp/disable", requireAuth, async (req, res): Promise<void> => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: "code required" });
    return;
  }
  const userId = req.user!.userId;
  const ok = await verifyTotpOrRecovery(userId, parsed.data.code);
  if (!ok) {
    res.status(400).json({ error: "Bad Request", message: "Invalid code" });
    return;
  }
  await db
    .update(usersTable)
    .set({ totpSecret: null, totpEnrolledAt: null, totpRecoveryCodes: null })
    .where(eq(usersTable.id, userId));
  res.json({ enrolled: false });
});

// ---------- Regenerate recovery codes ----------
router.post("/me/totp/recovery-codes", requireAuth, async (req, res): Promise<void> => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: "code required" });
    return;
  }
  const userId = req.user!.userId;
  const [user] = await db
    .select({ totpEnrolledAt: usersTable.totpEnrolledAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user?.totpEnrolledAt) {
    res.status(409).json({ error: "Conflict", message: "Two-factor is not enabled" });
    return;
  }
  const ok = await verifyTotpOrRecovery(userId, parsed.data.code);
  if (!ok) {
    res.status(400).json({ error: "Bad Request", message: "Invalid code" });
    return;
  }
  const recoveryCodes = generateRecoveryCodes();
  const hashed = await hashCodes(recoveryCodes);
  await db.update(usersTable).set({ totpRecoveryCodes: hashed }).where(eq(usersTable.id, userId));
  res.json({ recoveryCodes });
});

export default router;
