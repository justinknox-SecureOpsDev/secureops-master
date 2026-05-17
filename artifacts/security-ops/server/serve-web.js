/**
 * Zero-dependency static server for the Expo web export (web-dist/).
 *
 * - Serves files from web-dist/ at BASE_PATH (default "/").
 * - SPA fallback: any non-asset GET that 404s falls back to index.html so
 *   Expo Router client-side routes work on hard refresh / deep links.
 * - Long-lived caching for /_expo/static/** (hashed filenames),
 *   no-cache for index.html so deploys are visible immediately.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream");

const PORT = parseInt(process.env.PORT || "22706", 10);
const BASE_PATH = (process.env.BASE_PATH || "/").replace(/\/+$/, "");
const WEB_ROOT = path.resolve(__dirname, "..", "web-dist");
const INDEX_PATH = path.join(WEB_ROOT, "index.html");

if (!fs.existsSync(INDEX_PATH)) {
  console.error(
    `[serve-web] web-dist/index.html not found at ${INDEX_PATH}. ` +
      `Run 'pnpm --filter @workspace/security-ops run build' first.`,
  );
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function safeJoin(root, urlPath) {
  // Strip query/hash, decode, normalize. Reject escapes and malformed encoding.
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const resolved = path.normalize(path.join(root, clean));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

// Paths that belong to other artifacts behind the shared proxy. They should
// never reach this server in production, but if a misroute happens we want
// to surface it as 404 rather than silently serving the SPA index.html.
const FOREIGN_PATH_PREFIXES = ["/api", "/admin-portal"];
function isForeignPath(urlPath) {
  return FOREIGN_PATH_PREFIXES.some(
    (p) => urlPath === p || urlPath.startsWith(p + "/"),
  );
}

function sendFile(req, res, filePath, statusCode = 200) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);
  const isHashedAsset = /\/_expo\/static\//.test(filePath);
  const cacheControl = isHashedAsset
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": stat.size,
    "cache-control": cacheControl,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  pipeline(fs.createReadStream(filePath), res, () => {});
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  let urlPath = req.url || "/";

  // Strip BASE_PATH prefix so file lookups are relative to web-dist/.
  if (BASE_PATH && urlPath.startsWith(BASE_PATH)) {
    urlPath = urlPath.slice(BASE_PATH.length) || "/";
  }
  if (!urlPath.startsWith("/")) urlPath = "/" + urlPath;

  // Lightweight healthcheck used by the artifact's ensurePreviewReachable.
  if (urlPath === "/status") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (urlPath === "/") {
    sendFile(req, res, INDEX_PATH);
    return;
  }

  if (isForeignPath(urlPath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
    return;
  }

  const target = safeJoin(WEB_ROOT, urlPath);
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad Request");
    return;
  }

  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(req, res, target);
      return;
    }
    if (!err && stat.isDirectory()) {
      const idx = path.join(target, "index.html");
      if (fs.existsSync(idx)) {
        sendFile(req, res, idx);
        return;
      }
    }
    // SPA fallback for any non-asset GET — Expo Router will resolve it.
    const looksLikeAsset = /\.[a-z0-9]{1,8}$/i.test(urlPath);
    if (!looksLikeAsset) {
      sendFile(req, res, INDEX_PATH, 200);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[serve-web] serving ${WEB_ROOT} on http://0.0.0.0:${PORT}${BASE_PATH || "/"}`,
  );
});

function shutdown(signal) {
  console.log(`[serve-web] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
