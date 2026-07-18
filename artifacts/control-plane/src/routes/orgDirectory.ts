/**
 * PUBLIC org-directory resolve — the one unauthenticated operator-data surface.
 *
 * The mobile app maps a short org code to its customer backend ORIGIN here. This
 * mirrors the customer-side /api/org-directory/resolve contract, but is sourced
 * from the control-plane registry DB instead of a static ORG_DIRECTORY env.
 *
 * Posture: no-store, rate-limited, origin-only, https-in-prod, and it returns
 * ONLY {code,name,apiBaseUrl} — never secrets, contacts, or health. An org code
 * is a routing convenience, NOT auth; the caller still needs valid credentials
 * on the resolved backend.
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db";
import { IS_PROD } from "../config";
import { isValidOrgCode, normalizeOrgCode, toSafeOrigin } from "../orgCode";

export const orgDirectoryRouter = Router();

const resolveLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

orgDirectoryRouter.get("/org-directory/resolve", resolveLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // Public read endpoint — safe for cross-origin browser use (no credentials).
  res.setHeader("Access-Control-Allow-Origin", "*");

  const code = normalizeOrgCode(String(req.query.code ?? ""));
  if (!isValidOrgCode(code)) {
    res.status(400).json({ error: "Invalid org code" });
    return;
  }

  const { rows } = await pool.query<{ org_code: string; name: string; api_base_url: string }>(
    `SELECT org_code, name, api_base_url
       FROM control_plane_customers
      WHERE org_code = $1 AND is_active = TRUE
      LIMIT 1`,
    [code],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Organization code not found" });
    return;
  }

  const origin = toSafeOrigin(row.api_base_url, IS_PROD);
  if (!origin) {
    // A bad stored URL must never resolve to an unsafe target.
    res.status(404).json({ error: "Organization code not found" });
    return;
  }

  res.json({ code: row.org_code, name: row.name, apiBaseUrl: origin });
});
