import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
// CSP is intentionally disabled here: the admin portal is served from the
// same origin via the shared proxy and would need a non-trivial allow-list
// for Vite/inline styles. Crawlers and clickjacking are still blocked via
// the other helmet defaults (X-Frame-Options=DENY, X-Content-Type-Options,
// etc.). crossOriginResourcePolicy is set to "cross-origin" so signed
// uploads/downloads served from this API can still be embedded by the
// admin portal and mobile app.
app.use(
  helmet({
    contentSecurityPolicy: false,
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
  return set;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();
if (ALLOWED_ORIGINS.size === 0 && process.env.NODE_ENV === "production") {
  logger.error(
    "No CORS origins configured. Set ALLOWED_ORIGINS or REPLIT_DOMAINS so browser clients can reach the API.",
  );
}

app.use(
  cors({
    origin: (origin, cb) => {
      // No Origin header → server-to-server, curl, native fetch from
      // mobile (React Native sets no Origin). Always allow.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin.replace(/\/+$/, ""))) {
        return cb(null, true);
      }
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

export default app;
