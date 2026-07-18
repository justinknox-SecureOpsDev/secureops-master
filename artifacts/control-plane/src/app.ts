/**
 * Control-plane Express app.
 *
 * Wiring + trust boundaries:
 *   - helmet, with a CSP that permits ONLY same-origin scripts (the operator
 *     console uses external .js files — no inline scripts);
 *   - CORS locked to ALLOWED_ORIGINS ∪ REPLIT_DOMAINS (no-Origin allowed for
 *     native/curl), EXCEPT the public /api/org-directory/resolve which sets its
 *     own permissive header since it is read-only and non-credentialed;
 *   - public: /healthz, POST /api/auth/login, GET /api/org-directory/resolve;
 *   - everything else under /api is gated by requireOperator (JWT);
 *   - the static operator console is served from ./public.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { ALLOWED_ORIGINS, IS_PROD } from "./config";
import { requireOperator } from "./auth";
import { authRouter } from "./routes/auth";
import { customersRouter } from "./routes/customers";
import { remoteSettingsRouter } from "./routes/remoteSettings";
import { orgDirectoryRouter } from "./routes/orgDirectory";

const app = express();
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
  }),
);

app.use(
  cors({
    origin(origin, cb) {
      // No Origin header (native app / curl / same-origin server-side) is allowed.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  }),
);

app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Public routes (no operator JWT).
app.use("/api", authRouter);
app.use("/api", orgDirectoryRouter);

// Operator-gated API.
app.use("/api", requireOperator, customersRouter);
app.use("/api", requireOperator, remoteSettingsRouter);

// Static operator console. In dev the source lives at ../public relative to
// src/; the esbuild build copies it next to the bundle (dist/public).
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = IS_PROD ? path.resolve(here, "public") : path.resolve(here, "../public");
app.use(express.static(publicDir));

// SPA-ish fallback: any non-API GET serves the console shell.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

export default app;
