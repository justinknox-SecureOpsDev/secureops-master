// Single-port production build for Reserved VM deployment.
//
// Builds the web SPAs (admin portal + home) with their production base paths,
// exports the Expo mobile app for the web (served at /app), builds the API
// server bundle, then copies all build outputs into the API server's
// dist/static so the deployed server is self-contained and serves the whole
// product on ONE port. This is what `deployConfig`'s build command runs.
//
// Dev is unaffected: each artifact keeps running on its own Vite/Node workflow.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, extraEnv = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root, env: { ...process.env, ...extraEnv } });
}

// 1. Build the web SPAs. Their vite.config requires PORT + BASE_PATH even at
//    build time (PORT is irrelevant to the output but the config throws without
//    it). BASE_PATH determines the absolute asset URLs baked into index.html.
run("pnpm --filter @workspace/admin-portal run build", {
  NODE_ENV: "production",
  PORT: "8081",
  BASE_PATH: "/admin-portal/",
});
run("pnpm --filter @workspace/home run build", {
  NODE_ENV: "production",
  PORT: "8082",
  // The marketing site is the front door — served at the bare root so the
  // address bar stays clean (no "/home/"). Its assets are emitted with
  // absolute "/assets/..." URLs.
  BASE_PATH: "/",
});

// 1b. Export the Expo mobile app for the WEB, rooted at /app, so officers can
//     use the app from a phone browser without installing the native app.
//     EXPO_WEB_BASE_URL is read by artifacts/security-ops/app.config.js and
//     becomes `experiments.baseUrl`, prefixing every emitted asset URL and the
//     Expo Router basename with /app. Dev and native/OTA builds never set it.
run("pnpm --filter @workspace/security-ops run build", {
  NODE_ENV: "production",
  EXPO_WEB_BASE_URL: "/app",
});

// 2. Build the API server (esbuild single bundle -> artifacts/api-server/dist).
run("pnpm --filter @workspace/api-server run build", { NODE_ENV: "production" });

// 3. Copy the built SPAs next to the bundle so the server resolves them from
//    its own dist dir (robust regardless of cwd).
const staticRoot = path.join(root, "artifacts/api-server/dist/static");
rmSync(staticRoot, { recursive: true, force: true });
mkdirSync(staticRoot, { recursive: true });

const copies = [
  { from: "artifacts/admin-portal/dist/public", to: "admin-portal" },
  { from: "artifacts/home/dist/public", to: "home" },
  { from: "artifacts/security-ops/web-dist", to: "app" },
];
for (const c of copies) {
  const fromAbs = path.join(root, c.from);
  if (!existsSync(fromAbs)) {
    throw new Error(`Expected web build output missing: ${c.from}`);
  }
  cpSync(fromAbs, path.join(staticRoot, c.to), { recursive: true });
  console.log(`Copied ${c.from} -> artifacts/api-server/dist/static/${c.to}`);
}

console.log(
  "\n\u2705 Single-VM build complete: API + admin-portal + home + mobile web (/app) bundled on one port.",
);

// 4. Optional OTA publish on deploy. When this build runs with an EXPO_TOKEN
//    available (add it as a Replit secret so the deploy builder can see it),
//    automatically push an over-the-air JavaScript update to the production
//    channel — so republishing the server also ships the latest mobile bundle
//    to installed apps with no manual `eas update`. Best-effort and NON-FATAL:
//    a missing token is skipped silently, and any eas failure logs loudly but
//    never fails the server deploy (the API is the critical path; OTA is not).
//
//    Per-platform split: iOS and Android may be on different native-binary
//    runtimes. runtimeVersion.policy = "appVersion", so an OTA at version X
//    only reaches devices whose installed binary was built at version X.
//    When IOS_OTA_RUNTIME is set (e.g. "1.0.2") and differs from the current
//    app.json version (e.g. "1.0.3"), we temporarily patch app.json and push
//    a separate iOS OTA at the live Apple runtime so iPhone users stay current.
//    Clear IOS_OTA_RUNTIME (or set it to match app.json) once a new iOS binary
//    is published at the current version.
if (process.env.EXPO_TOKEN) {
  const stamp = new Date().toISOString();
  let sha = "unknown";
  try {
    sha = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  } catch {
    // git history may be unavailable in the deploy builder — fall back to timestamp only.
  }
  const message = `Auto OTA on deploy ${stamp} (${sha})`;
  const appJsonPath = path.join(root, "artifacts/security-ops/app.json");
  const appJsonRaw = readFileSync(appJsonPath, "utf8");
  const appJson = JSON.parse(appJsonRaw);
  const currentVersion = appJson.expo.version;
  const iosRuntime = process.env.IOS_OTA_RUNTIME;
  const needsSplit = iosRuntime && iosRuntime !== currentVersion;

  try {
    if (needsSplit) {
      // Push iOS OTA at the live Apple binary's runtime version.
      console.log(`\nEXPO_TOKEN detected — pushing iOS OTA at runtime ${iosRuntime} (IOS_OTA_RUNTIME)…`);
      appJson.expo.version = iosRuntime;
      writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
      try {
        run(
          `pnpm --filter @workspace/security-ops exec expo export --platform ios --output-dir dist`,
          { CI: "1" },
        );
        run(
          `EAS_NO_VCS=1 pnpm --filter @workspace/security-ops exec eas update --branch production --skip-bundler --non-interactive --platform ios --message ${JSON.stringify(message)}`,
        );
        console.log(`\u2705 iOS OTA published at runtime ${iosRuntime}.`);
      } finally {
        // Always restore app.json before the Android push.
        appJson.expo.version = currentVersion;
        writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));
      }

      // Push Android OTA at the current (1.0.3) runtime.
      console.log(`\nPushing Android OTA at runtime ${currentVersion}…`);
      run(
        `pnpm --filter @workspace/security-ops exec expo export --platform android --output-dir dist`,
        { CI: "1" },
      );
      run(
        `EAS_NO_VCS=1 pnpm --filter @workspace/security-ops exec eas update --branch production --skip-bundler --non-interactive --platform android --message ${JSON.stringify(message)}`,
      );
      console.log(`\u2705 Android OTA published at runtime ${currentVersion}.`);
    } else {
      // Both platforms on the same runtime — single combined push.
      console.log("\nEXPO_TOKEN detected — publishing production OTA update…");
      run(
        `pnpm --filter @workspace/security-ops exec eas update --branch production --non-interactive --message ${JSON.stringify(message)}`,
      );
      console.log("\u2705 OTA update published to the production channel.");
    }
  } catch (err) {
    console.error(
      `\u26A0\uFE0F  Auto OTA publish failed — server deploy continues, mobile bundle NOT updated this republish: ${err?.message ?? err}`,
    );
    // Ensure app.json is restored even on error.
    try {
      const current = JSON.parse(readFileSync(appJsonPath, "utf8"));
      if (current.expo.version !== currentVersion) {
        current.expo.version = currentVersion;
        writeFileSync(appJsonPath, JSON.stringify(current, null, 2));
      }
    } catch { /* best-effort */ }
  }
} else {
  console.log(
    "\n\u2139\uFE0F  No EXPO_TOKEN set — skipping automatic OTA publish. Add EXPO_TOKEN as a Replit secret to push an OTA on every republish.",
  );
}
