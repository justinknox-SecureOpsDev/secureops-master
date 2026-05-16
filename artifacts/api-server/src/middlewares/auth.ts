import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, usersTable, revokedTokensTable } from "@workspace/db";

// SESSION_SECRET is required to sign JWTs. In production we hard-fail at
// import time so a misconfigured deploy never silently issues tokens with a
// well-known secret. In dev we fall back so local boot stays painless, but
// log a loud warning.
function resolveJwtSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET environment variable is required in production " +
        "(must be at least 16 characters). Refusing to start with a fallback secret.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[auth] SESSION_SECRET not set — using insecure dev fallback. Set SESSION_SECRET before deploying.",
  );
  return "fallback-secret-change-me";
}

const JWT_SECRET = resolveJwtSecret();
const TOKEN_TTL_DAYS = 7;

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function signToken(payload: { userId: string; email: string; role: string }): string {
  const jti = randomUUID();
  return jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn: `${TOKEN_TTL_DAYS}d` });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function tokenTtlSeconds(): number {
  return TOKEN_TTL_DAYS * 24 * 60 * 60;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "No token provided" });
    return;
  }
  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
    return;
  }

  // Re-check the current user row so stale tokens from demoted or deactivated
  // accounts are rejected immediately — the JWT alone is not sufficient.
  try {
    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        status: usersTable.status,
        mustChangePassword: usersTable.mustChangePassword,
        tokensValidAfter: usersTable.tokensValidAfter,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId))
      .limit(1);

    if (!user || user.status !== "active") {
      res.status(401).json({ error: "Unauthorized", message: "Account is not active" });
      return;
    }

    // Bulk session revocation: if the token was issued before the user's
    // tokens_valid_after watermark, treat it as logged out. Bumping that
    // column on the user (self "log out everywhere" / admin "revoke
    // sessions") instantly invalidates all outstanding JWTs.
    const iatMs = (payload.iat ?? 0) * 1000;
    if (iatMs < user.tokensValidAfter.getTime()) {
      res.status(401).json({ error: "Unauthorized", message: "Session was revoked. Please sign in again." });
      return;
    }

    // Per-token revocation: explicit single-session logout adds the jti
    // to the revoked_tokens table. Lookup is keyed by primary key so it's
    // a single indexed read.
    if (payload.jti) {
      const [revoked] = await db
        .select({ jti: revokedTokensTable.jti })
        .from(revokedTokensTable)
        .where(eq(revokedTokensTable.jti, payload.jti))
        .limit(1);
      if (revoked) {
        res.status(401).json({ error: "Unauthorized", message: "Session was revoked. Please sign in again." });
        return;
      }
    }

    // Use the live DB role — not the role baked into the token — so demotions
    // take effect on the very next request.
    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
    };

    // Enforce server-side: accounts with mustChangePassword=true are locked to
    // password-management and identity routes only. All other API access is
    // denied until the user rotates their credential. This prevents the
    // low-entropy temporary password from being used to access production data
    // even if the account somehow transitions to active before the user acts.
    if (user.mustChangePassword) {
      const allowed = req.path.startsWith("/auth/");
      if (!allowed) {
        res.status(403).json({
          error: "Forbidden",
          message: "You must change your password before accessing this resource",
          mustChangePassword: true,
        });
        return;
      }
    }

    next();
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error", message: "Authentication check failed" });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      req.user = verifyToken(authHeader.slice(7));
    } catch {
      // ignore — treat as anonymous
    }
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin") {
      res.status(403).json({ error: "Forbidden", message: "Admin access required" });
      return;
    }
    next();
  });
}
