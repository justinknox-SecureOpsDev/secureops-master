---
name: iOS/Android OTA runtime split
description: iOS is on a different native-binary runtime than Android; OTAs must be pushed per-platform or iOS users silently miss every update.
---

# iOS / Android OTA runtime split

## The rule
When iOS and Android native binaries are at **different `expo.version` values**,
`eas update --branch production` (no `--platform` flag) only reaches the
platform whose installed runtime matches the current `app.json` version. The
other platform silently receives nothing.

**Why:** `runtimeVersion.policy = "appVersion"` — the OTA bundle is keyed by
the version string in `app.json` at export time; devices reject bundles whose
runtime key doesn't match their binary's version.

## How to apply
- Before pushing any OTA (manual or auto), confirm the live runtimes:
  `eas build:list --platform ios --limit 3` and `eas build:list --platform android --limit 3`.
- If runtimes differ, push per-platform:
  1. Temporarily set `app.json` version to the iOS runtime, export iOS, push with `--skip-bundler --platform ios`, restore `app.json`.
  2. Export Android at the current (Android) version, push `--platform android`.
- `build-single-vm.mjs` (auto-OTA on deploy) reads the `IOS_OTA_RUNTIME` env var.
  When it differs from `app.json` version, it performs the per-platform split
  automatically. **Clear or update `IOS_OTA_RUNTIME` when a new iOS binary is
  published at the current version.**

## Current state (as of 2026-08-08)
- Android: runtime **1.0.3** (3 FINISHED builds)
- iOS: runtime **1.0.2** (build 17 — latest Apple App Store release)
- `app.json`: version **1.0.3**
- `IOS_OTA_RUNTIME` env var: **"1.0.2"** (shared environment)
- Auto-OTA on deploy now pushes iOS at 1.0.2 and Android at 1.0.3 on each deploy.

## Manual OTA procedure (one platform, different runtime)
```bash
# 1. Temporarily patch version
python3 -c "import json; d=json.load(open('app.json')); d['expo']['version']='1.0.2'; open('app.json','w').write(json.dumps(d,indent=2))"
# 2. Export
cd artifacts/security-ops && CI=1 timeout 280 npx expo export --platform ios --output-dir dist
# 3. Push
EAS_NO_VCS=1 npx eas update --branch production --skip-bundler --non-interactive --platform ios --message "..."
# 4. Restore
python3 -c "import json; d=json.load(open('app.json')); d['expo']['version']='1.0.3'; open('app.json','w').write(json.dumps(d,indent=2))"
```

## When iOS catches up
Once a new iOS binary at 1.0.3 is published to the App Store:
1. `setEnvVars({ environment: "shared", values: { IOS_OTA_RUNTIME: "1.0.3" } })` (or delete it)
2. The auto-OTA script will fall back to the simple single-push path.
