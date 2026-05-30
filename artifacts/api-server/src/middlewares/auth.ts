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

// Throttle map: userId → last DB-write timestamp (ms). We only update the
// `users.last_active_at` column at most once per LAST_ACTIVE_THROTTLE_MS
// per user, because clients (mobile location pings, websocket polling)
// can issue dozens of authed requests per minute and we don't want to
// turn a hot read path into a hot write path.
//
// Bounded growth: in a long-lived multi-tenant deployment the map could
// otherwise accumulate one entry per distinct user ever seen since boot.
// We cap it at LAST_ACTIVE_MAX_ENTRIES; before each insert that would
// exceed the cap we prune any entries older than the throttle window
// (those entries serve no purpose — the next request from that user
// would write to the DB regardless of whether the entry exists). If the
// map is still at capacity after pruning we drop the single oldest
// entry. This is bounded work — at most one full scan and one min
// search — and only runs when growth would otherwise be unbounded.
const LAST_ACTIVE_THROTTLE_MS = 60_000;
const LAST_ACTIVE_MAX_ENTRIES = 10_000;
const lastActiveStamps = new Map<string, number>();

function pruneLastActive(now: number): void {
  const cutoff = now - LAST_ACTIVE_THROTTLE_MS;
  for (const [id, ts] of lastActiveStamps) {
    if (ts < cutoff) lastActiveStamps.delete(id);
  }
  if (lastActiveStamps.size >= LAST_ACTIVE_MAX_ENTRIES) {
    let oldestId: string | null = null;
    let oldestTs = Infinity;
    for (const [id, ts] of lastActiveStamps) {
      if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
    }
    if (oldestId) lastActiveStamps.delete(oldestId);
  }
}

async function stampLastActive(userId: string): Promise<void> {
  const now = Date.now();
  const prev = lastActiveStamps.get(userId) ?? 0;
  if (now - prev < LAST_ACTIVE_THROTTLE_MS) return;
  if (!lastActiveStamps.has(userId) && lastActiveStamps.size >= LAST_ACTIVE_MAX_ENTRIES) {
    pruneLastActive(now);
  }
  lastActiveStamps.set(userId, now);
  try {
    await db.update(usersTable).set({ lastActiveAt: new Date(now) }).where(eq(usersTable.id, userId));
  } catch {
    // If the write fails (e.g. transient DB blip), drop the throttle
    // entry so the next request retries instead of waiting a full minute.
    lastActiveStamps.delete(userId);
  }
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

    // Throttled "last active" stamp — fire-and-forget so the request path
    // is never blocked on an extra DB write. The in-memory map keeps us
    // from doing a write on every single authenticated request from a
    // chatty client (mobile pings location every 60s, etc.).
    void stampLastActive(user.id);

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

/**
 * Authorize the Dispatch command center surface: admin OR dispatcher.
 *
 * The `dispatcher` role is a narrow operations role used by the unified
 * `/admin-portal/dispatch` screen. Dispatchers can see the live map, the
 * clock-in status board, open shifts in the next 72h, active incidents,
 * and the broadcast composer; they can also assign officers to open
 * shifts and add comments to incidents. They are NOT allowed into
 * payroll, invoices, HR (apps/onboarding/invitations), the audit log,
 * admin CRUD over `/admin/tables/*`, or the system-status endpoint —
 * those stay gated by `requireAdmin`.
 */
export function requireAdminOrDispatcher(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const role = req.user?.role;
    if (role !== "admin" && role !== "dispatcher") {
      res.status(403).json({ error: "Forbidden", message: "Admin or dispatcher access required" });
      return;
    }
    next();
  });
}

/**
 * Gate routes to authenticated users with role="client" only.
 *
 * Client users are external venue contacts (not staff) with access limited
 * to data scoped to their own organisation's sites. This guard must be
 * combined with the server-side scoping helper `getClientSiteIds` on every
 * endpoint to ensure the caller can only see their own org's data.
 *
 * Security: we re-check the live DB role (already done in requireAuth) so
 * a role demotion from "client" takes effect immediately without waiting for
 * the JWT to expire.
 */
export function requireClient(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== "client") {
      res.status(403).json({ error: "Forbidden", message: "Client access required" });
      return;
    }
    next();
  });
}

/**
 * Gate routes to internal staff (admin, dispatcher, employee) — i.e. any
 * authenticated user EXCEPT external `client` portal contacts. Use for
 * endpoints that expose internal operational data (e.g. the officer
 * clock-in site picker) which clients must never see, but where finer
 * employee-vs-admin scoping isn't required.
 */
export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const role = req.user?.role;
    if (role !== "admin" && role !== "dispatcher" && role !== "employee") {
      res.status(403).json({ error: "Forbidden", message: "Staff access required" });
      return;
    }
    next();
  });
}

/**
 * Gate routes to admin OR client roles. Used for shared read endpoints
 * where admins see everything and clients see their scoped subset.
 */
export function requireAdminOrClient(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const role = req.user?.role;
    if (role !== "admin" && role !== "client") {
      res.status(403).json({ error: "Forbidden", message: "Admin or client access required" });
      return;
    }
    next();
  });
}
