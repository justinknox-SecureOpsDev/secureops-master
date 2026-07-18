import { Router } from "express";
import { z } from "zod/v4";
import { logger } from "../lib/logger";
import { orgDirectoryLimiter } from "../middlewares/rateLimit";

/**
 * Public organization directory.
 *
 * ONE mobile-app-store build serves MANY customers, each with their own API
 * deployment + DB. The app asks the user for a short organization "code", then
 * calls this endpoint to resolve that code to the customer's backend ORIGIN.
 * All subsequent backend traffic from the app is routed to that origin.
 *
 * SECURITY: an org code is a ROUTING convenience, NOT authentication. Resolving
 * a code reveals only a public backend URL + display name; the caller still
 * needs valid credentials on that backend to do anything useful. We resolve ONE
 * code at a time (never enumerate the directory) and never return secrets.
 *
 * No auth — registered before the auth middleware. Rate-limited per IP.
 */

const router = Router();

type OrgEntry = { code: string; name: string; apiBaseUrl: string };

// Short, human-typeable codes only — mirrors the mobile client's ORG_CODE_RE.
const ORG_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const codeSchema = z.string().regex(ORG_CODE_RE);

/**
 * Normalize a configured backend URL to an ORIGIN ONLY (scheme + host[:port]).
 * Rejects anything carrying a path/query/fragment and anything that isn't
 * https. In production EVERY http: origin is rejected (including
 * localhost/127.0.0.1) so the directory can never hand a client a plaintext
 * backend; http: is permitted only outside production for local testing.
 * Returns null if invalid. Mirrors the client's normalizeOrigin so a directory
 * entry that the client would reject is caught server-side first.
 */
function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const httpsOk = u.protocol === "https:";
  const httpDevOk =
    u.protocol === "http:" && process.env.NODE_ENV !== "production";
  if (!httpsOk && !httpDevOk) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (u.search || u.hash) return null;
  return u.origin;
}

/**
 * Parse the ORG_DIRECTORY env var — a JSON array of
 * { code, name, apiBaseUrl } entries — into a code → entry map. Invalid or
 * missing config yields an empty directory. Parsed lazily and memoized so a
 * malformed value is logged once at first lookup, not on every request.
 */
let cachedDirectory: Map<string, OrgEntry> | null = null;

function loadDirectory(): Map<string, OrgEntry> {
  if (cachedDirectory) return cachedDirectory;
  const map = new Map<string, OrgEntry>();
  const raw = process.env.ORG_DIRECTORY;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("ORG_DIRECTORY must be a JSON array");
      }
      for (const item of parsed) {
        const e = (item ?? {}) as Partial<OrgEntry>;
        if (typeof e.code !== "string" || typeof e.apiBaseUrl !== "string") continue;
        const code = e.code.trim().toLowerCase();
        if (!ORG_CODE_RE.test(code)) {
          logger.error(`ORG_DIRECTORY entry '${e.code}' has an invalid code; skipping`);
          continue;
        }
        const origin = normalizeOrigin(e.apiBaseUrl);
        if (!origin) {
          logger.error(`ORG_DIRECTORY entry '${code}' has an invalid apiBaseUrl; skipping`);
          continue;
        }
        map.set(code, {
          code,
          name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : origin,
          apiBaseUrl: origin,
        });
      }
    } catch (err) {
      logger.error(
        `Failed to parse ORG_DIRECTORY env: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  cachedDirectory = map;
  return map;
}

/**
 * Test-only hook: drop the memoized directory so a test can mutate
 * process.env.ORG_DIRECTORY between cases and have the next lookup re-parse it.
 * Never called by production code.
 */
export function __resetOrgDirectoryCacheForTests(): void {
  cachedDirectory = null;
}

/**
 * Resolve THIS deployment's own public ORIGIN (scheme + host, no path) from the
 * operator-configured base URL. Mirrors the email-link resolution used
 * elsewhere: APP_BASE_URL wins, then the first REPLIT_DOMAINS value over https.
 * Returns null if neither yields a valid origin.
 */
export function getSelfOrigin(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) {
    const o = normalizeOrigin(explicit);
    if (o) return o;
  }
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) {
    const o = normalizeOrigin(`https://${replitDomain}`);
    if (o) return o;
  }
  return null;
}

/**
 * Resolve THIS deployment's own organization code + display name, so the admin
 * portal can show a ready-to-share invite link / QR without anyone hardcoding
 * the code into the build.
 *
 * Resolution order (never hardcoded):
 *   1. `ORG_CODE` env — an explicit per-deployment override. Lets a customer
 *      backend declare its own code even when it isn't itself the directory
 *      host (the directory deployment is usually a different box). When the
 *      code also appears in a locally-configured ORG_DIRECTORY, its richer
 *      display name is reused.
 *   2. Otherwise, match this deployment's own origin against the entries in
 *      ORG_DIRECTORY (the directory host knows itself this way).
 *
 * Returns null when the code can't be determined — the admin UI then explains
 * how to configure it rather than guessing.
 */
export function resolveSelfOrgInvite(): { code: string; name: string } | null {
  const explicit = process.env.ORG_CODE?.trim().toLowerCase();
  if (explicit && ORG_CODE_RE.test(explicit)) {
    const fromDir = loadDirectory().get(explicit);
    return { code: explicit, name: fromDir?.name ?? explicit };
  }

  const self = getSelfOrigin();
  if (self) {
    for (const entry of loadDirectory().values()) {
      if (entry.apiBaseUrl === self) return { code: entry.code, name: entry.name };
    }
  }

  return null;
}

router.get("/org-directory/resolve", orgDirectoryLimiter, (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const rawCode = typeof req.query.code === "string" ? req.query.code.trim().toLowerCase() : "";
  const parsed = codeSchema.safeParse(rawCode);
  if (!parsed.success) {
    return res.status(400).json({ error: "Bad Request", message: "Invalid organization code." });
  }
  const code = parsed.data;

  const entry = loadDirectory().get(code);
  if (entry) {
    return res.json({ code: entry.code, name: entry.name, apiBaseUrl: entry.apiBaseUrl });
  }

  // Dev convenience: with no directory configured, synthesize an entry that
  // points the app back at THIS server, so a developer can exercise the connect
  // flow locally without standing up a separate directory. NEVER in production —
  // there an unknown code must 404 so the app shows "couldn't find that code".
  if (process.env.NODE_ENV !== "production") {
    const host = req.get("host");
    if (host) {
      const proto = req.protocol === "https" ? "https" : "http";
      const origin = normalizeOrigin(`${proto}://${host}`);
      if (origin) {
        return res.json({ code, name: `${code} (dev)`, apiBaseUrl: origin });
      }
    }
  }

  return res.status(404).json({ error: "Not Found", message: "Unknown organization code." });
});

export default router;
