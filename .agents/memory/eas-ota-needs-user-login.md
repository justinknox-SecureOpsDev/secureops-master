---
name: EAS OTA — auto-on-republish + agent can't push interactively
description: OTA auto-publishes during the VM build when EXPO_TOKEN is set; OTA is JS-only so server/schema changes still need a VM republish.
---

**Auto-OTA on republish (wired):** `scripts/build-single-vm.mjs` (the `build:vm`
deploy build) ends with an OTA step gated on `process.env.EXPO_TOKEN`. When the
secret is present it runs `eas update --branch production` for `@workspace/security-ops`;
**best-effort / NON-FATAL** (try/catch — a missing token skips silently, any eas
failure logs but never fails the server deploy). So a normal Reserved-VM republish
now also ships the latest mobile JS bundle. `postBuild` is `pnpm store prune` which
runs *after* `build:vm`, so eas-cli (a security-ops devDep) is still installed during
the build. The app already auto-consumes OTA (expo-updates default check-on-launch;
app.json has `runtimeVersion.policy:"appVersion"`, no explicit `updates` block needed).

**Interactive push from the agent:** still not possible without the token — `eas update`
needs an authenticated Expo account. With `EXPO_TOKEN` set as a Replit secret it works
non-interactively (the auto step above). Manual fallback documented in
`docs/mobile-ota-and-add-org-runbook.md` Part B:
`cd artifacts/security-ops && eas update --branch production`.

**Channel↔branch mapping is NOT automatic (silent zero-delivery):** publishing to a
*branch* delivers nothing unless the store build's *channel* is mapped to it. The
`production` channel here had an EMPTY branchMapping until 2026-07-14, so every prior
"Auto OTA on deploy" publish sat undelivered. Fix (one-time):
`eas channel:edit production --branch production --non-interactive`. When debugging
"devices never get updates", check `eas channel:view production` FIRST — `updateBranches: []`
means unmapped, regardless of what `update:list --branch` shows.

**Agent-side publish under the 120s bash cap:** a full two-platform `eas update`
bundles ~4+ min and gets killed. Working recipe: (1) publish per platform
(`--platform android` then `ios`); (2) set `EAS_SKIP_AUTO_FINGERPRINT=1` (fingerprinting
alone can eat ~30s); (3) if a run dies after "Exported: dist", rerun with `--skip-bundler`
to reuse `dist/` (upload-only, seconds). Warm Metro cache makes retries faster. `rm -rf dist`
after. Also: the first `eas update` run writes `updates.url` into app.json AND flushes
plugin-derived values (duplicate UIBackgroundModes "audio", the whole Android permission
list) — keep `updates.url`, dedupe the rest before committing.

**OTA runbooks/runbook project IDs:** `OTA_RELEASE_RUNBOOK.md` predates the new app
record — current EAS project is `e8bcd802-…` (`u.expo.dev/e8bcd802-…`), runtime `1.0.0`;
ignore the stale `452c8467`/`1.0.2` references.

**Key caveats to relay whenever a mobile change ships:**
- OTA ships **JavaScript only**. Any server route / payload / DB-schema change the
  new bundle depends on needs a **separate Reserved-VM republish** (and prod
  `db push` — see prod-schema-no-auto-migrate). Correct order: prod db push →
  VM republish → EAS OTA.
- Pushing the OTA *before* the server deploy is safe-but-inert: an old server that
  doesn't return a new user flag leaves the mobile gate falsy (feature dormant),
  and the new endpoint 404s — so don't gate users until the server is live.
- Already-logged-in sessions are **not** re-gated until next login, because
  AuthContext restores the cached user object on launch.
- Keep app version unchanged for OTA-only releases (must match the installed
  build's channel, e.g. `production`).
