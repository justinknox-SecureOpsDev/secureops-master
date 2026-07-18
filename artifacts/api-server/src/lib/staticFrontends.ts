import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { logger } from "./logger";

// In a single-port (Reserved VM) production build, the API server also serves
// the pre-built web SPAs. `scripts/build-single-vm.mjs` copies each SPA's build
// output into `<api-server-dist>/static/<name>`. After esbuild bundles this
// file into dist/index.mjs, `import.meta.url` resolves to that bundle, so the
// static root is `<dist>/static`.
//
// In dev and tests the static dir does not exist (each SPA runs on its own Vite
// workflow), so this module no-ops cleanly and never interferes with the API.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(moduleDir, "static");

function escapeForRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Mount the built web SPAs behind the API. MUST be called AFTER `/api` is
 * mounted so static serving can never shadow an API route or the WS upgrade
 * paths.
 *
 * Layout served on one port:
 *   - The admin portal lives under `/admin-portal/` (its own base path).
 *   - The marketing site (`home`) is the FRONT DOOR at the bare root `/` — its
 *     assets are emitted with absolute `/assets/...` URLs, so it owns the root.
 *
 * Each SPA gets static asset serving plus an HTML history-fallback so client-
 * side deep links survive a refresh. `GET /` returns the marketing HTML with a
 * 200 (never a 3xx) on purpose: the Reserved-VM startup probe hits `GET /` and
 * a redirect there can fail the promote step. The root history-fallback is
 * scoped so it NEVER shadows `/api` or `/admin-portal` and only serves the SPA
 * shell for non-file HTML requests (real assets are served by express.static
 * first). Helmet/CORS already ran upstream, so these responses carry the same
 * security headers as the API.
 */
export function mountStaticFrontends(app: Express): void {
  const adminDir = path.join(STATIC_ROOT, "admin-portal");
  const homeDir = path.join(STATIC_ROOT, "home");
  const hasAdmin = fs.existsSync(path.join(adminDir, "index.html"));
  const hasHome = fs.existsSync(path.join(homeDir, "index.html"));

  if (!hasAdmin) {
    logger.warn(
      { dir: adminDir },
      "Static frontend not found — skipping admin portal (expected in dev/test; built only for single-VM production)",
    );
  }
  if (!hasHome) {
    logger.warn(
      { dir: homeDir },
      "Static frontend not found — skipping marketing site (expected in dev/test; built only for single-VM production)",
    );
  }

  if (!hasAdmin && !hasHome) {
    return;
  }

  // --- Admin portal under /admin-portal ----------------------------------
  // Registered BEFORE the root marketing handlers so admin asset/HTML requests
  // are resolved here and never reach the root SPA fallback.
  if (hasAdmin) {
    const adminIndex = path.join(adminDir, "index.html");
    const escaped = escapeForRegExp("/admin-portal");

    // Bare mount without trailing slash -> redirect so relative links resolve.
    // Anchored with `$` so it matches ONLY "/admin-portal", never
    // "/admin-portal/": Express's non-strict routing treats the string route
    // "/admin-portal" as also matching the trailing-slash form, which would
    // make "/admin-portal/" redirect to itself in an infinite loop.
    app.get(new RegExp(`^${escaped}$`), (_req: Request, res: Response) => {
      res.redirect("/admin-portal/");
    });

    // Serve real files. index:false hands index.html control to the fallback
    // below so every non-file route inside the app returns the SPA shell.
    app.use("/admin-portal", express.static(adminDir, { index: false, fallthrough: true }));

    // SPA history fallback: any GET under /admin-portal/ that wants HTML and
    // isn't a real asset -> admin index.html.
    app.get(new RegExp(`^${escaped}/`), (req: Request, res: Response, next: NextFunction) => {
      if (!req.accepts("html")) return next();
      res.sendFile(adminIndex);
    });
  }

  // --- Marketing site at the bare root / ---------------------------------
  if (hasHome) {
    const homeIndex = path.join(homeDir, "index.html");

    // Serve the marketing site's real files (hashed JS/CSS, favicon, images)
    // from the root. index:false so "/" falls through to the history-fallback
    // below, which returns a 200 HTML body for the Reserved-VM startup probe.
    app.use("/", express.static(homeDir, { index: false, fallthrough: true }));

    // Root SPA history fallback. Scoped so it never shadows the API or the
    // admin portal, and only serves the marketing shell for HTML navigations
    // (real assets were already served by express.static above). RegExp route
    // for Express 5 compatibility.
    app.get(/.*/, (req: Request, res: Response, next: NextFunction) => {
      if (!req.accepts("html")) return next();
      const p = req.path;
      if (p === "/api" || p.startsWith("/api/")) return next();
      if (p === "/admin-portal" || p.startsWith("/admin-portal/")) return next();
      // Don't hand the SPA shell to asset-like requests (a dot in the final
      // path segment, e.g. /missing.js). express.static already served real
      // files above; anything left that looks like a file should 404, not
      // return HTML — even when a client sends a permissive Accept header.
      const lastSegment = p.slice(p.lastIndexOf("/") + 1);
      if (lastSegment.includes(".")) return next();
      res.sendFile(homeIndex);
    });

    logger.info(
      { mounted: hasAdmin ? ["/", "/admin-portal"] : ["/"] },
      "Static frontends mounted (single-VM mode) — marketing site at root",
    );
    return;
  }

  // No marketing site present (defensive — should not happen in a real VM
  // build). Keep the root reachable by forwarding to the admin portal with a
  // 200 (not a 302) so the startup probe on `GET /` still passes.
  const rootHtml =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="refresh" content="0; url=/admin-portal/">` +
    `<link rel="canonical" href="/admin-portal/">` +
    `<title>SecureOps Command</title></head>` +
    `<body><p>Redirecting to <a href="/admin-portal/">SecureOps Command</a>…</p>` +
    `</body></html>`;
  app.get("/", (_req: Request, res: Response) => {
    res.status(200).type("html").send(rootHtml);
  });

  logger.info(
    { mounted: ["/admin-portal"], rootTarget: "/admin-portal/" },
    "Static frontends mounted (single-VM mode) — admin portal only",
  );
}
