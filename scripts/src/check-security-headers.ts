/**
 * Smoke test: boot the API server in production mode and verify that the
 * launch-pack security headers are applied. Catches regressions where, for
 * example, someone disables helmet's CSP, loosens CORS, or removes a
 * required directive when adding a new third-party dependency.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check-security-headers
 *
 * Builds the api-server into a private, isolated output dir (NOT the shared
 * `artifacts/api-server/dist/`) and spawns that build as a child process with
 * NODE_ENV=production and known ALLOWED_ORIGINS, then makes real HTTP requests
 * to assert headers. Exits 0 on pass, 1 on fail.
 *
 * The isolated output dir is important: when the api-server *dev* workflow is
 * running, it rebuilds the shared `dist/` (esbuild clears it mid-build), so a
 * gate that spawned `dist/index.mjs` would intermittently fail with
 * "Cannot find module .../dist/index.mjs". Building/spawning from our own dir
 * sidesteps that race entirely.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process";
import http from "http";
import { fileURLToPath } from "url";
import path from "path";
import net from "net";
import { mkdtempSync, rmSync } from "fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_DIR = path.resolve(here, "../../artifacts/api-server");

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function header(headers: http.IncomingHttpHeaders, name: string): string {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(", ") : (v ?? "");
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

async function request(port: number, path: string, headers: Record<string, string> = {}): Promise<http.IncomingMessage> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers, timeout: 4000 },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.end();
  });
}

async function main(): Promise<void> {
  // Build into a private dir, NOT the shared artifacts/api-server/dist/, so we
  // never race the dev workflow rebuilding (and momentarily clearing) that
  // directory mid-run. It must live INSIDE the api-server artifact dir so that
  // externalized deps (pdfkit, sharp, bcrypt, …) still resolve via the same
  // node_modules chain as the normal dist/ build.
  const outDir = mkdtempSync(path.join(API_SERVER_DIR, ".secheaders-build-"));
  console.log(`[build] building api-server into isolated dir ${outDir}`);
  const buildRes = spawnSync(
    "node",
    ["./build.mjs"],
    {
      cwd: API_SERVER_DIR,
      env: { ...process.env, API_SERVER_OUT_DIR: outDir },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (buildRes.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(`api-server build failed (exit code ${buildRes.status ?? "null"})`);
  }
  const serverEntry = path.join(outDir, "index.mjs");

  const port = await pickFreePort();
  // Reuse the existing DATABASE_URL — /api/healthz doesn't actually touch
  // the DB, but the api-server's import graph initializes a Drizzle pool
  // that resolves the connection string. Falling back to a placeholder
  // lets the script still boot in environments without one.
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
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("exit", (code) => {
      if (code != null && code !== 0 && !stderr.includes("[shutdown]")) {
        console.error(`[child] api-server exited with code ${code}\n${stderr}`);
      }
    });
    await waitFor(port);

    const checks: Check[] = [];
    const baseRes = await request(port, "/api/healthz");
    const csp = header(baseRes.headers, "content-security-policy");
    checks.push({ name: "CSP header is present", ok: csp.length > 0 });
    for (const required of [
      "frame-ancestors 'none'",
      "object-src 'none'",
      "default-src 'self'",
      "script-src 'self'",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      "https://*.tile.openstreetmap.org",
      // The web /connect screen resolves an org code against the central org
      // directory cross-origin; connect-src must allow that origin or the
      // browser blocks the resolve fetch even though the endpoint is CORS-open.
      "https://secureops-command.replit.app",
    ]) {
      checks.push({ name: `CSP contains: ${required}`, ok: csp.includes(required), detail: csp.includes(required) ? undefined : csp });
    }

    checks.push({ name: "X-Content-Type-Options=nosniff", ok: header(baseRes.headers, "x-content-type-options") === "nosniff" });
    checks.push({ name: "Strict-Transport-Security is set", ok: header(baseRes.headers, "strict-transport-security").length > 0 });
    checks.push({
      name: "Cross-Origin-Resource-Policy=cross-origin",
      ok: header(baseRes.headers, "cross-origin-resource-policy") === "cross-origin",
    });

    const allowedRes = await request(port, "/api/healthz", { Origin: "https://portal.example.com" });
    checks.push({
      name: "CORS allows ALLOWED_ORIGINS entry",
      ok: header(allowedRes.headers, "access-control-allow-origin") === "https://portal.example.com",
    });

    let corsBlocked = false;
    try {
      const blockedRes = await request(port, "/api/healthz", { Origin: "https://evil.example.net" });
      corsBlocked = header(blockedRes.headers, "access-control-allow-origin") === "";
    } catch {
      corsBlocked = true;
    }
    checks.push({ name: "CORS rejects unknown browser origin", ok: corsBlocked });

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) {
      const mark = c.ok ? "OK  " : "FAIL";
      console.log(`[${mark}] ${c.name}${c.detail ? `  (got: ${c.detail.slice(0, 200)})` : ""}`);
    }
    console.log(`\n${checks.length - failed.length}/${checks.length} security-header checks passed.`);
    if (failed.length > 0) process.exit(1);
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      // Give it a moment, then SIGKILL if still alive.
      await new Promise<void>((r) => {
        const to = setTimeout(() => { try { child!.kill("SIGKILL"); } catch { /* ignore */ } r(); }, 1500);
        child!.on("exit", () => { clearTimeout(to); r(); });
      });
    }
    rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[check-security-headers] crashed:", err);
  process.exit(1);
});
