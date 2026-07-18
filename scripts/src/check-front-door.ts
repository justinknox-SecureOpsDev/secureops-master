/**
 * Front-door routing gate: prove the single-port (Reserved VM) layout keeps the
 * marketing site as the public front door without ever shadowing the admin
 * portal or the API.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-front-door
 *
 * The single deployed process serves THREE things on ONE port:
 *   - the marketing site ("home") at the bare root `/`,
 *   - the admin portal under `/admin-portal/`,
 *   - the JSON API under `/api`.
 *
 * The wiring that keeps these from colliding lives in
 * `artifacts/api-server/src/lib/staticFrontends.ts` (the root catch-all that
 * must never swallow `/api` or `/admin-portal`) and in
 * `scripts/build-single-vm.mjs` (which must keep emitting the marketing site at
 * the bare root with absolute `/assets/...` URLs). A regression in either ships
 * silently today — this gate catches it.
 *
 * What it does (mirrors the security-headers gate so the dev workflow's rebuild
 * of the shared `dist/` can never race it):
 *   1. Builds the admin-portal + home SPAs with their production base paths
 *      (exactly as `build-single-vm.mjs` does).
 *   2. Builds the api-server into a PRIVATE, isolated output dir (NOT the shared
 *      `artifacts/api-server/dist/`).
 *   3. Copies the SPA build outputs into `<isolated-dist>/static/{admin-portal,home}`
 *      so the bundle resolves them exactly as it would in production.
 *   4. Boots that bundle with NODE_ENV=production and makes real HTTP requests
 *      to assert the routing contract below.
 *
 * Exits 0 on pass, 1 on fail.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import http from "http";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";
import net from "net";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync } from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const API_SERVER_DIR = path.resolve(ROOT, "artifacts/api-server");

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function header(headers: http.IncomingHttpHeaders, name: string): string {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : (v ?? "");
}

function run(cmd: string, extraEnv: Record<string, string> = {}): void {
  console.log(`\n$ ${cmd}`);
  const res = spawnSync(cmd, {
    cwd: ROOT,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (exit ${res.status ?? "null"}): ${cmd}`);
  }
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function request(
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: "GET", headers, timeout: 4000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.end();
  });
}

interface WsUpgradeResult {
  /** HTTP status seen: 101 means the upgrade handshake completed. */
  status: number;
  /** Whether the server returned a valid RFC6455 Sec-WebSocket-Accept. */
  acceptValid: boolean;
  /**
   * Close code of the first frame the server pushed after the handshake.
   * The chat handler completes the 101 handshake first, THEN closes with
   * 1008 "Token required" when no `?token=` is supplied — so seeing 1008 here
   * proves wsManager's connection handler actually ran (the auth challenge was
   * reached) without us needing real credentials.
   */
  closeCode: number | null;
}

/**
 * Perform a real WebSocket upgrade handshake (no `ws` dependency) and report
 * whether it was accepted/handled. We intentionally send NO `?token=` so the
 * server reaches its documented auth challenge instead of opening an authed
 * session — proving the WS path is reachable on the single port and not
 * shadowed by the static-frontend mounts or the root catch-all.
 */
async function wsUpgrade(port: number, reqPath: string): Promise<WsUpgradeResult> {
  return await new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: reqPath,
      method: "GET",
      timeout: 5000,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    let settled = false;
    const done = (v: WsUpgradeResult) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on("upgrade", (res, socket, head: Buffer) => {
      const accept = (res.headers["sec-websocket-accept"] as string | undefined) ?? "";
      const acceptValid = accept === expectedAccept;
      const finish = (closeCode: number | null) => {
        socket.destroy();
        done({ status: res.statusCode ?? 101, acceptValid, closeCode });
      };
      // The server pushes a close frame (unmasked, opcode 0x8) with the auth
      // challenge right after the handshake. That frame frequently rides along
      // in the upgrade `head` buffer (same TCP segment as the 101) and only
      // sometimes arrives as a follow-up 'data' event — so check both. If no
      // close frame is observed in time the 101 + valid accept already prove
      // the upgrade was reached, so we resolve with closeCode=null.
      const parseClose = (buf: Buffer | undefined): number | null =>
        buf && buf.length >= 4 && (buf[0] & 0x0f) === 0x8 ? buf.readUInt16BE(2) : null;
      const fromHead = parseClose(head);
      if (fromHead !== null) {
        finish(fromHead);
        return;
      }
      const fallback = setTimeout(() => finish(null), 2000);
      socket.once("data", (buf: Buffer) => {
        clearTimeout(fallback);
        finish(parseClose(buf));
      });
    });
    // A non-101 status (e.g. the dispatcher's raw 404 for an unknown WS path)
    // arrives as a normal HTTP response instead of an upgrade.
    req.on("response", (res) => {
      res.resume();
      done({ status: res.statusCode ?? 0, acceptValid: false, closeCode: null });
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
    req.on("timeout", () => req.destroy(new Error("ws upgrade timeout")));
    req.end();
  });
}

async function waitFor(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await request(port, "/api/healthz");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server did not respond on port ${port} within ${timeoutMs}ms`);
}

/** Pull the first absolute `/assets/....js` reference out of an index.html. */
function firstAssetJs(html: string, basePrefix: string): string | null {
  const re = new RegExp(`["'](${basePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}assets/[^"']+?\\.js)["']`);
  const m = html.match(re);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  // 1. Build the web SPAs exactly as the single-VM deploy build does. Their
  //    vite.config requires PORT + BASE_PATH; BASE_PATH decides the absolute
  //    asset URLs baked into index.html (and is the whole point of this gate).
  run("pnpm --filter @workspace/admin-portal run build", {
    NODE_ENV: "production",
    PORT: "8081",
    BASE_PATH: "/admin-portal/",
  });
  run("pnpm --filter @workspace/home run build", {
    NODE_ENV: "production",
    PORT: "8082",
    BASE_PATH: "/",
  });

  // 2. Build the api-server into a private, isolated dir so we never race the
  //    api-server dev workflow rebuilding (and momentarily clearing) the shared
  //    dist/. It must live INSIDE the api-server artifact dir so externalized
  //    deps (pdfkit, sharp, bcrypt, …) resolve via the same node_modules chain.
  //
  //    The prefix MUST NOT start with a dot. `res.sendFile()` runs the absolute
  //    path through the `send` library, whose default `dotfiles: "ignore"`
  //    rejects ANY path containing a dot-segment — so a dot-prefixed build dir
  //    (like the security-headers gate's, which never calls sendFile) would make
  //    every SPA history-fallback 404. Production serves from `dist/static`
  //    (no dot), so this only ever bites the test harness.
  const outDir = mkdtempSync(path.join(API_SERVER_DIR, "frontdoor-build-"));
  try {
    console.log(`\n[build] building api-server into isolated dir ${outDir}`);
    const buildRes = spawnSync("node", ["./build.mjs"], {
      cwd: API_SERVER_DIR,
      env: { ...process.env, API_SERVER_OUT_DIR: outDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (buildRes.status !== 0) {
      throw new Error(`api-server build failed (exit code ${buildRes.status ?? "null"})`);
    }

    // 3. Copy the SPA build outputs next to the bundle so the server resolves
    //    them from its own dist dir (exactly like build-single-vm.mjs).
    const staticRoot = path.join(outDir, "static");
    const copies = [
      { from: "artifacts/admin-portal/dist/public", to: "admin-portal" },
      { from: "artifacts/home/dist/public", to: "home" },
    ];
    for (const c of copies) {
      const fromAbs = path.join(ROOT, c.from);
      if (!existsSync(path.join(fromAbs, "index.html"))) {
        throw new Error(`Expected web build output missing: ${c.from}/index.html`);
      }
      cpSync(fromAbs, path.join(staticRoot, c.to), { recursive: true });
    }

    const serverEntry = path.join(outDir, "index.mjs");
    const port = await pickFreePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      SESSION_SECRET: process.env.SESSION_SECRET ?? "test-session-secret-at-least-32-chars-long",
      ALLOWED_ORIGINS: "https://portal.example.com",
      REPLIT_DOMAINS: "portal.example.repl.co",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:5432/test",
      SEED_DEMO_USERS: "false",
    };

    let child: ChildProcess | null = null;
    try {
      child = spawn("node", [serverEntry], { env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString();
      });
      child.on("exit", (code) => {
        if (code != null && code !== 0 && !stderr.includes("[shutdown]")) {
          console.error(`[child] api-server exited with code ${code}\n${stderr}`);
        }
      });
      await waitFor(port);

      const checks: Check[] = [];

      // --- Marketing site is the front door at the bare root -------------
      const root = await request(port, "/");
      const rootIsHtml = header(root.headers, "content-type").includes("text/html");
      const rootRefsAssets = /["']\/assets\//.test(root.body);
      const rootIsAdminShell = /["']\/admin-portal\/assets\//.test(root.body);
      checks.push({ name: "GET / -> 200", ok: root.status === 200, detail: `status ${root.status}` });
      checks.push({ name: "GET / is HTML", ok: rootIsHtml, detail: header(root.headers, "content-type") });
      checks.push({ name: "GET / is the marketing shell (references /assets/...)", ok: rootRefsAssets });
      checks.push({
        name: "GET / is NOT the admin shell (front door stays marketing)",
        ok: rootRefsAssets && !rootIsAdminShell,
      });

      // --- Deep link into the marketing SPA survives a refresh -----------
      const deep = await request(port, "/pricing");
      checks.push({ name: "GET /pricing (deep link) -> 200", ok: deep.status === 200, detail: `status ${deep.status}` });
      checks.push({
        name: "GET /pricing is HTML",
        ok: header(deep.headers, "content-type").includes("text/html"),
      });
      checks.push({
        name: "GET /pricing returns the same marketing shell as /",
        ok: deep.body === root.body,
      });

      // --- Hashed marketing asset is served with a JS content-type ------
      const homeIndex = readFileSync(path.join(staticRoot, "home", "index.html"), "utf8");
      const assetJs = firstAssetJs(homeIndex, "/");
      if (!assetJs) {
        checks.push({ name: "marketing index.html references a hashed /assets/*.js", ok: false, detail: "no <script src=/assets/*.js> found" });
      } else {
        const asset = await request(port, assetJs);
        const assetType = header(asset.headers, "content-type");
        checks.push({ name: `GET ${assetJs} -> 200`, ok: asset.status === 200, detail: `status ${asset.status}` });
        checks.push({
          name: `GET ${assetJs} has a JS content-type`,
          ok: /javascript/.test(assetType),
          detail: assetType,
        });
      }

      // --- Admin portal still owns /admin-portal/ -----------------------
      const admin = await request(port, "/admin-portal/");
      checks.push({ name: "GET /admin-portal/ -> 200", ok: admin.status === 200, detail: `status ${admin.status}` });
      checks.push({
        name: "GET /admin-portal/ is the admin shell (references /admin-portal/assets/...)",
        ok: /["']\/admin-portal\/assets\//.test(admin.body),
      });

      // Bare /admin-portal (no trailing slash) must redirect, not 404 and not
      // get swallowed by the root marketing fallback.
      const adminBare = await request(port, "/admin-portal");
      const loc = header(adminBare.headers, "location");
      checks.push({
        name: "GET /admin-portal redirects to the trailing slash",
        ok: (adminBare.status === 301 || adminBare.status === 302) && loc.endsWith("/admin-portal/"),
        detail: `status ${adminBare.status} location ${loc || "(none)"}`,
      });

      // --- API is never shadowed by the root fallback -------------------
      const healthz = await request(port, "/api/healthz");
      let healthOk = false;
      try {
        healthOk = healthz.status === 200 && JSON.parse(healthz.body).status === "ok";
      } catch {
        healthOk = false;
      }
      checks.push({ name: "GET /api/healthz -> 200 JSON (not shadowed by root)", ok: healthOk, detail: `status ${healthz.status}` });

      const version = await request(port, "/api/version");
      let versionOk = false;
      try {
        const parsed = JSON.parse(version.body);
        versionOk = version.status === 200 && typeof parsed.version === "string" && parsed.version.length > 0;
      } catch {
        versionOk = false;
      }
      checks.push({ name: "GET /api/version -> 200 JSON (not shadowed by root)", ok: versionOk, detail: `status ${version.status}` });

      // An UNKNOWN /api/... path is the dangerous regression this gate exists
      // for: if the root marketing fallback ever stopped excluding `/api`, an
      // unknown API path would be swallowed and returned as a 200 HTML
      // marketing shell instead of the API router's JSON 404. Send a
      // browser-like Accept header (the worst case — the root fallback only
      // fires when the client accepts HTML) and assert we get a non-200,
      // non-HTML (JSON) response handled by the API router's 404.
      const unknownApi = await request(port, "/api/this-route-does-not-exist", {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      });
      const unknownApiType = header(unknownApi.headers, "content-type");
      checks.push({
        name: "GET /api/<unknown> -> 404 (not swallowed by root marketing fallback)",
        ok: unknownApi.status === 404,
        detail: `status ${unknownApi.status}`,
      });
      checks.push({
        name: "GET /api/<unknown> is JSON, not the marketing HTML shell (JSON 404 from the API router)",
        ok: /application\/json/.test(unknownApiType),
        detail: unknownApiType || "(no content-type)",
      });

      // --- Real-time WebSocket survives the single-port layout ----------
      // Chat + live presence ride the SAME single port at `/api/ws`. The
      // static-frontend mounts and the root catch-all serve only HTTP GETs;
      // upgrade requests are routed by the dedicated `server.on('upgrade')`
      // dispatcher in index.ts. Prove that dispatcher still wins by driving a
      // real WS handshake (no token, so we hit the auth challenge instead of
      // needing real credentials).
      let ws: WsUpgradeResult | null = null;
      try {
        ws = await wsUpgrade(port, "/api/ws");
      } catch (err) {
        checks.push({
          name: "WS upgrade GET /api/ws is reached (not shadowed by static/root)",
          ok: false,
          detail: `upgrade failed: ${(err as Error).message}`,
        });
      }
      if (ws) {
        checks.push({
          name: "WS upgrade GET /api/ws -> 101 Switching Protocols (reachable on single port)",
          ok: ws.status === 101,
          detail: `status ${ws.status}`,
        });
        checks.push({
          name: "WS upgrade GET /api/ws returns a valid Sec-WebSocket-Accept (real handshake)",
          ok: ws.acceptValid,
        });
        // The handler closes an unauthenticated socket with 1008 right after
        // the handshake. Observing that is *stronger* evidence (wsManager's
        // connection handler ran), but it is not mandatory: the 101 + valid
        // accept above already prove the upgrade was reached on the single
        // port. So we fail only on a WRONG close code, never on a missed one
        // (the close frame's arrival timing is not deterministic).
        checks.push({
          name: "WS upgrade GET /api/ws auth challenge (1008 close when observed)",
          ok: ws.closeCode === 1008 || ws.closeCode === null,
          detail:
            ws.closeCode === 1008
              ? "closeCode 1008 (auth challenge reached)"
              : ws.closeCode === null
                ? "no close frame captured (101 handshake already proves reachability)"
                : `unexpected closeCode ${ws.closeCode}`,
        });
      }

      const failed = checks.filter((c) => !c.ok);
      for (const c of checks) {
        const mark = c.ok ? "OK  " : "FAIL";
        console.log(`[${mark}] ${c.name}${c.detail ? `  (${c.detail.slice(0, 200)})` : ""}`);
      }
      console.log(`\n${checks.length - failed.length}/${checks.length} front-door routing checks passed.`);
      if (failed.length > 0) process.exit(1);
    } finally {
      if (child && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => {
          const to = setTimeout(() => {
            try {
              child!.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            r();
          }, 1500);
          child!.on("exit", () => {
            clearTimeout(to);
            r();
          });
        });
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[check-front-door] crashed:", err);
  process.exit(1);
});
