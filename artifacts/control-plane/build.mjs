import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { build as esbuild } from "esbuild";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

// This artifact ships from the same master checkout as the customer API server.
// Keep its reference build identity in lockstep with api-server/build.mjs so the
// fleet compares a tenant's /api/version against the actual master revision.
function resolveMasterBuildVersion() {
  if (process.env.BUILD_VERSION) return process.env.BUILD_VERSION;
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: artifactDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const MASTER_BUILD_VERSION = resolveMasterBuildVersion();

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    define: {
      __MASTER_BUILD_VERSION__: JSON.stringify(MASTER_BUILD_VERSION),
    },
    external: [
      "*.node",
      "bcrypt",
      "argon2",
      "fsevents",
      "pg-native",
      "better-sqlite3",
      "sqlite3",
    ],
    sourcemap: "linked",
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  // The operator console is static (HTML/CSS/JS, no build step) and served by
  // Express. Copy it next to the bundle so the production run command (which
  // runs from dist/) can find it at a stable, relative location.
  await cp(path.resolve(artifactDir, "public"), path.resolve(distDir, "public"), {
    recursive: true,
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
