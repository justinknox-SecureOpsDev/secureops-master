import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { mountStaticFrontends } from "./lib/staticFrontends";

const app: Express = express();

// Behind Replit's reverse proxy — trust the immediate hop so req.ip
// reflects the real client IP for rate limiting and audit logging.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// --- Security headers (helmet) -------------------------------------------
// crossOriginResourcePolicy is set to "cross-origin" so signed uploads /
// downloads served from this API can still be embedded by the admin portal
// and mobile app. Other helmet defaults (HSTS, X-Frame-Options=DENY,
// X-Content-Type-Options) stay on.
//
// Content-Security-Policy is enabled in production only. Vite's dev server
// uses inline scripts and HMR over a websocket that a strict CSP would
// break, so we leave it off in development. The production policy is tuned
// for the admin portal's actual needs:
//   - script-src: self only (Vite emits hashed JS bundles)
//   - style-src: self + Google Fonts CSS + 'unsafe-inline' for runtime
//     style injection by Radix/Tailwind utilities
//   - font-src:  self + Google Fonts woff2 hosts
//   - img-src:   self + data: (icons) + blob: (file previews) + https:
//                (signed object-storage downloads)
//   - connect-src: self + wss://<self> for the chat WebSocket. Tile servers
//                for the live map are explicitly allow-listed.
//   - frame-ancestors: 'none' (no embedding the portal anywhere)
//
// The web connect screen (/app/connect) fetches the CENTRAL org directory
// cross-origin to resolve an org code → backend origin, then hard-navigates
// there. That directory lives at the canonical SecureOps Command deployment —
// the same origin the mobile client hardcodes as DEFAULT_NATIVE_ORIGIN in
// artifacts/security-ops/utils/api.ts (keep the two in sync). The resolve
// endpoint is CORS-open, but the page's own connect-src would still make the
// browser BLOCK that request, so the directory origin must be allow-listed
// here too. Operators whose web build points EXPO_PUBLIC_ORG_DIRECTORY_URL at
// a different host add that origin via ORG_DIRECTORY_ORIGINS (comma-separated).
const ORG_DIRECTORY_CONNECT_SRC = Array.from(
  new Set(
    [
      "https://secureops-command.replit.app",
      ...(process.env.ORG_DIRECTORY_ORIGINS || "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, "")),
    ].filter(Boolean),
  ),
);

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  // unpkg.com hosts the Leaflet build that the live-map srcdoc iframes load
  // (admin Dispatch, SiteDetailPage, mobile LiveOfficerMap, OfficerProfile).
  // The iframes inherit the parent CSP, so without these origins the map
  // renders an empty blue tile background.
  scriptSrc: ["'self'", "https://unpkg.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  // mediaSrc covers <audio>/<video>. Radio playback streams recordings
  // as fetched blobs (blob: URLs); we also allow https: for any future
  // signed-URL direct embeds.
  mediaSrc: ["'self'", "blob:", "https:"],
  connectSrc: [
    "'self'",
    "ws:",
    "wss:",
    "https://*.tile.openstreetmap.org",
    ...ORG_DIRECTORY_CONNECT_SRC,
  ],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  objectSrc: ["'none'"],
  upgradeInsecureRequests: [],
};

app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === "production"
        ? { useDefaults: true, directives: CSP_DIRECTIVES }
        : false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// --- CORS ----------------------------------------------------------------
// Lock CORS to known origins:
//   * ALLOWED_ORIGINS env (comma-separated) — explicit operator allow-list.
//   * REPLIT_DOMAINS — every Replit-managed domain assigned to this deploy.
// Same-origin requests have no Origin header and are always allowed.
// Anything else is rejected by the cors middleware.
function buildAllowedOrigins(): Set<string> {
  const set = new Set<string>();
  const explicit = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of explicit) set.add(o.replace(/\/+$/, ""));
  const replitDomains = (process.env.REPLIT_DOMAINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const d of replitDomains) {
    set.add(`https://${d}`);
    set.add(`http://${d}`);
  }
  // Also accept the dev host for local Expo / vite previews.
  if (process.env.NODE_ENV !== "production") {
    set.add("http://localhost:80");
    set.add("http://localhost:5000");
    set.add("http://localhost:25580");
  }
  // Expo's web preview is served from a separate subdomain
  // (<id>.expo.janeway.replit.dev) while the API and admin portal live on
  // <id>.janeway.replit.dev. The mobile web build hits the regular dev
  // domain for /api, which is cross-origin — so the Expo subdomain must be
  // in the allow-list or login preflights fail with "failed to fetch".
  const expoDomain = (process.env.REPLIT_EXPO_DEV_DOMAIN || "").trim();
  if (expoDomain) {
    set.add(`https://${expoDomain}`);
    set.add(`http://${expoDomain}`);
  }
  return set;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();
if (ALLOWED_ORIGINS.size === 0 && process.env.NODE_ENV === "production") {
  logger.error(
    "No CORS origins configured. Set ALLOWED_ORIGINS or REPLIT_DOMAINS so browser clients can reach the API.",
  );
}

app.use(
  cors((req, cb) => {
    // The public org-directory resolve endpoint is a stateless, credential-free
    // routing lookup: ONE app-store build serves MANY customer backends, so a
    // browser on ANY customer origin must be able to resolve a code to its
    // backend. Non-browser clients (the native app, curl, server-to-server)
    // already read it without CORS at all, so opening it to browsers exposes
    // nothing new. Open to all origins, NEVER with credentials.
    const path = (req as unknown as { path: string }).path;
    if (path === "/api/org-directory/resolve") {
      return cb(null, { origin: "*", credentials: false });
    }
    // Everything else stays locked to the operator allow-list.
    return cb(null, {
      origin: (origin, ocb) => {
        // No Origin header → server-to-server, curl, native fetch from
        // mobile (React Native sets no Origin). Always allow.
        if (!origin) return ocb(null, true);
        if (ALLOWED_ORIGINS.has(origin.replace(/\/+$/, ""))) {
          return ocb(null, true);
        }
        return ocb(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
    });
  }),
);

// Stripe webhooks must receive the raw body for signature verification.
// This handler runs BEFORE express.json() so the body isn't parsed yet.
// All other routes continue to use the JSON parser below.
app.use("/api/client/stripe-webhook", express.raw({ type: "application/json" }));

// Use the `verify` callback to capture the raw body buffer for HMAC-SHA256
// webhook signature verification. This is the correct Express pattern:
// the verify callback fires while body-parser reads the stream, so the
// parsed JSON body is still populated normally via req.body.
// Scheduler webhook handlers read (req as any).rawBody; all other routes
// simply ignore it.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf.toString("utf8");
  },
}));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

// Android App Links verification — must be served before the SPA fallback so
// the marketing-site history handler never shadows it.
app.get("/.well-known/assetlinks.json", (_req, res) => {
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.secureopscommand.app",
        sha256_cert_fingerprints: [
          "E6:7D:62:E5:6C:D4:4D:FA:5A:FC:67:D0:7E:3F:EF:D5:3D:45:AF:00:41:50:D9:26:08:B5:2D:DD:9F:D9:41:BC",
        ],
      },
    },
  ]);
});

// Single-port (Reserved VM) production builds also serve the pre-built web SPAs
// (admin portal, home) from dist/static so the whole product runs on one port.
// Mounted AFTER /api so it can never shadow an API route; no-ops in dev/test
// where the static dir is absent (the SPAs run on their own Vite workflows).
mountStaticFrontends(app);

export default app;
