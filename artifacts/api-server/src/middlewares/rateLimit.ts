import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * Auth-endpoint rate limiting.
 *
 * Goals:
 *   - Stop attackers flooding officers' inboxes via /auth/forgot-password.
 *   - Stop credential-stuffing on /auth/login.
 *   - Stop brute-forcing of reset tokens on /auth/reset-password.
 *
 * Strategy: stack independent per-IP and per-email limiters. A single
 * attacker IP can't burn through any one inbox, AND a distributed
 * attacker rotating IPs still hits a global per-email cap on the
 * victim's address.
 *
 * Limits are configurable via env vars; defaults are conservative
 * enough for normal humans (typos / second attempts) but tight enough
 * to make automated abuse impractical.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WINDOW_MIN = envInt("AUTH_RATE_LIMIT_WINDOW_MIN", 15);
const FORGOT_PER_EMAIL_MAX = envInt("AUTH_FORGOT_RATE_LIMIT_MAX", 5);
const FORGOT_PER_IP_MAX = envInt("AUTH_FORGOT_IP_RATE_LIMIT_MAX", 20);
const LOGIN_PER_EMAIL_MAX = envInt("AUTH_LOGIN_RATE_LIMIT_MAX", 10);
const LOGIN_PER_IP_MAX = envInt("AUTH_LOGIN_IP_RATE_LIMIT_MAX", 30);
const RESET_PER_IP_MAX = envInt("AUTH_RESET_RATE_LIMIT_MAX", 10);

const windowMs = WINDOW_MIN * 60 * 1000;

function emailKey(req: Request): string {
  const raw = (req.body as { email?: unknown })?.email;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function tooMany(_req: Request, res: Response): void {
  res.status(429).json({
    error: "Too Many Requests",
    message: "Too many attempts. Please wait a few minutes and try again.",
  });
}

type KeyMode = "ip" | "email";

function makeLimiter(opts: { max: number; keyBy: KeyMode; tag: string }): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany,
    // Skip per-email limiters when no email was supplied — let the
    // per-IP limiter (or the route's own validation) handle it. This
    // also prevents a shared empty-string bucket from being exhausted
    // by malformed requests across users.
    skip: (req) => opts.keyBy === "email" && emailKey(req) === "",
    keyGenerator: (req) => {
      if (opts.keyBy === "ip") return `${opts.tag}:ip:${ipKeyGenerator(req.ip ?? "")}`;
      return `${opts.tag}:em:${emailKey(req)}`;
    },
  });
}

// /auth/forgot-password — strictest. Apply BOTH a per-email cap (so a
// distributed attacker rotating IPs still can't flood one inbox) and a
// per-IP cap (so one source can't enumerate by rotating emails).
export const forgotPasswordEmailLimiter: RateLimitRequestHandler = makeLimiter({
  max: FORGOT_PER_EMAIL_MAX,
  keyBy: "email",
  tag: "fp",
});
export const forgotPasswordIpLimiter: RateLimitRequestHandler = makeLimiter({
  max: FORGOT_PER_IP_MAX,
  keyBy: "ip",
  tag: "fp",
});

// /auth/login — defense in depth: per-email (stuffing one account) and
// per-IP (spraying many accounts).
export const loginEmailLimiter: RateLimitRequestHandler = makeLimiter({
  max: LOGIN_PER_EMAIL_MAX,
  keyBy: "email",
  tag: "lg",
});
export const loginIpLimiter: RateLimitRequestHandler = makeLimiter({
  max: LOGIN_PER_IP_MAX,
  keyBy: "ip",
  tag: "lg",
});

// /auth/reset-password — token guessing protection, keyed on IP only
// (no email is sent, just a token).
export const resetPasswordLimiter: RateLimitRequestHandler = makeLimiter({
  max: RESET_PER_IP_MAX,
  keyBy: "ip",
  tag: "rp",
});

// /storage/uploads/request-url — authenticated endpoint that mints GCS signed
// PUT URLs. Rate-limited per IP as defense-in-depth even though auth is required.
const UPLOAD_URL_PER_IP_MAX = envInt("UPLOAD_URL_RATE_LIMIT_MAX", 60);

export const uploadUrlLimiter: RateLimitRequestHandler = makeLimiter({
  max: UPLOAD_URL_PER_IP_MAX,
  keyBy: "ip",
  tag: "uu",
});

// /storage/uploads/application-url — unauthenticated endpoint for the HR
// application pipeline (Apply / Onboard / Amend). Strict per-IP cap because
// the route is fully public; 10 URL grants per window is enough for a
// complete multi-file application submission while making automated flooding
// impractical.
const APPLICATION_UPLOAD_PER_IP_MAX = envInt("APPLICATION_UPLOAD_RATE_LIMIT_MAX", 10);

export const applicationUploadLimiter: RateLimitRequestHandler = makeLimiter({
  max: APPLICATION_UPLOAD_PER_IP_MAX,
  keyBy: "ip",
  tag: "au",
});
