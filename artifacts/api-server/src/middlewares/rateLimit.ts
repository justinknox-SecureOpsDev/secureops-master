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

// POST /applications — fully public application submit. 5 per IP per hour
// is generous for legitimate applicants but stops bot-driven spam.
const APPLICATION_SUBMIT_PER_IP_MAX = envInt("APPLICATION_SUBMIT_RATE_LIMIT_MAX", 5);
const HOUR_MS = 60 * 60 * 1000;

export const publicApplicationLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: HOUR_MS,
  limit: APPLICATION_SUBMIT_PER_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => `pa:ip:${ipKeyGenerator(req.ip ?? "")}`,
});

// GET / POST /onboarding/:token, GET / POST /applications/amend/:token —
// public token-based endpoints. Cap per-IP to slow brute-force token
// guessing while leaving plenty of headroom for legitimate retries.
const TOKEN_LOOKUP_PER_IP_MAX = envInt("TOKEN_LOOKUP_RATE_LIMIT_MAX", 60);
const FIVE_MIN_MS = 5 * 60 * 1000;

export const tokenLookupLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: FIVE_MIN_MS,
  limit: TOKEN_LOOKUP_PER_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => `tk:ip:${ipKeyGenerator(req.ip ?? "")}`,
});

// POST /applications/draft — public "save and resume later" save action.
// Sends an email per call, so we apply BOTH caps (mirrors forgot-password):
//   - per-IP: stops one source from spraying drafts to many addresses
//   - per-email: stops a distributed attacker rotating IPs from flooding
//                a single target inbox with resume emails
const APPLICATION_DRAFT_PER_IP_MAX = envInt("APPLICATION_DRAFT_RATE_LIMIT_MAX", 10);
const APPLICATION_DRAFT_PER_EMAIL_MAX = envInt("APPLICATION_DRAFT_PER_EMAIL_MAX", 5);

export const applicationDraftIpLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: HOUR_MS,
  limit: APPLICATION_DRAFT_PER_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => `pd:ip:${ipKeyGenerator(req.ip ?? "")}`,
});

export const applicationDraftEmailLimiter: RateLimitRequestHandler = makeLimiter({
  max: APPLICATION_DRAFT_PER_EMAIL_MAX,
  keyBy: "email",
  tag: "pd",
});

// Stricter limiter for unauthenticated endpoints that do real work
// (PDF render, attachment signing). Keeps a single recipient from
// hammering the share PDF endpoint into a DoS.
const PUBLIC_SHARE_EXPENSIVE_PER_IP_MAX = envInt("PUBLIC_SHARE_EXPENSIVE_RATE_LIMIT_MAX", 15);
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

export const publicShareExpensiveLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: FIFTEEN_MIN_MS,
  limit: PUBLIC_SHARE_EXPENSIVE_PER_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => `pse:ip:${ipKeyGenerator(req.ip ?? "")}`,
});

// POST /emergency — authenticated, but rate-limited per user to prevent
// runaway loops or malicious flooding from spamming admin push channels.
// Keyed by userId; falls back to IP if somehow unauthenticated.
const EMERGENCY_PER_USER_MAX = envInt("EMERGENCY_RATE_LIMIT_MAX", 5);
const ONE_MIN_MS = 60 * 1000;

export const emergencyLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: ONE_MIN_MS,
  limit: EMERGENCY_PER_USER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => {
    const uid = req.user?.userId;
    if (uid) return `em:u:${uid}`;
    return `em:ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
});

// POST /me/dar — end-of-shift Daily Activity Report. Officers normally
// file one per shift; a generous 10/hr/user cap absorbs retries and
// multi-site split shifts while preventing a compromised account from
// flooding the admin feed.
const DAR_PER_USER_MAX = envInt("DAR_RATE_LIMIT_MAX", 10);

export const darWriteLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: DAR_PER_USER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => {
    const uid = req.user?.userId;
    if (uid) return `dar:u:${uid}`;
    return `dar:ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
});

// GET /dar/:id/pdf — PDFKit render is CPU/memory-heavier than JSON
// routes. Per-user cap absorbs legitimate "view, then download" workflows
// while preventing a logged-in account from looping the renderer.
const DAR_PDF_PER_USER_MAX = envInt("DAR_PDF_RATE_LIMIT_MAX", 30);

export const darPdfLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: DAR_PDF_PER_USER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => {
    const uid = req.user?.userId;
    if (uid) return `darpdf:u:${uid}`;
    return `darpdf:ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
});

// POST /admin/exports/* — admin-only data export endpoints (preview /
// CSV / PDF). The PDF render in particular can scan up to ~10k rows
// and stream a multi-page document, so we cap per-admin throughput to
// keep one runaway tab from sustained-pinning a worker. 20/hr/user is
// generous for normal "pull a weekly report" usage.
const EXPORT_PER_USER_MAX = envInt("EXPORT_RATE_LIMIT_MAX", 20);

export const exportLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: HOUR_MS,
  limit: EXPORT_PER_USER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => {
    const uid = req.user?.userId;
    if (uid) return `exp:u:${uid}`;
    return `exp:ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
});

// POST /me/location — authenticated location pings from the mobile app.
// The app pings every ~60s while clocked in, so a generous per-user cap
// of 30/min still leaves 2x headroom for legitimate retries while
// preventing a malicious or buggy client from rapidly flipping
// inside/outside coords to spam the geofence alert channel.
const LOCATION_PER_USER_MAX = envInt("LOCATION_RATE_LIMIT_MAX", 30);

export const locationLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: ONE_MIN_MS,
  limit: LOCATION_PER_USER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany,
  keyGenerator: (req) => {
    const uid = req.user?.userId;
    if (uid) return `loc:u:${uid}`;
    return `loc:ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
});
