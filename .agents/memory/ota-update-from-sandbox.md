---
name: Pushing an OTA update from this sandbox
description: How to run `eas update` for security-ops despite the 120s bash cap — split export/upload; also the auto-OTA-on-deploy pipeline and workflow-limit dead ends.
---

**Auto-OTA already exists:** the single-VM deploy build auto-publishes an OTA
("Auto OTA on deploy <stamp> (<sha>)") to the `production` branch whenever the
deploy builder has `EXPO_TOKEN` (see `scripts/build-single-vm.mjs`, best-effort
/ non-fatal). So a server republish usually ships the mobile bundle too — check
`eas update:list --branch production` before assuming a manual push is needed.

**Manual push under the 120s bash cap:** a plain `eas update` (Metro export of
ios+android) exceeds the cap and gets killed. Split it:
1. `cd artifacts/security-ops && CI=1 timeout 113 npx expo export --platform ios --platform android --output-dir dist`
   — Metro's on-disk cache persists across killed attempts, so retries converge;
   with a warm cache the whole export fits in one call.
2. `EAS_NO_VCS=1 eas update --branch production --skip-bundler --non-interactive --message "..."`
   — upload-only, finishes in well under 110s.

**Dead ends (don't retry):**
- Detached `spawn` from the code_execution notebook does NOT survive — the
  notebook gets recycled between calls and children are reaped.
- A temporary workflow can't be added: the project has 15+ grandfathered
  workflows over the 10-workflow limit, so ANY `configureWorkflow` for a new
  name is rejected until ~6 are deleted.

**Targeting facts:** OTA reaches installed builds by EAS project + channel +
runtime version, NOT bundle/ASC ids directly — the production channel's
builds are `com.secureopscommand.mobile` / ASC app 6789409652, policy
`appVersion` (so never bump `expo.version` for an OTA-only release; an OTA
must target the runtime the installed base actually runs). July 2026: repo
`app.json` is `1.0.1` (radio keep-alive binary — new native module expo-audio);
installed base stays runtime `1.0.0` until Apple releases that build, so an
OTA for existing installs targets `1.0.0` until then.
`artifacts/security-ops/OTA_RELEASE_RUNBOOK.md` is STALE (retired EAS project
`452c8467…`, wrong versions); `RADIO_NATIVE_RELEASE_RUNBOOK.md` was corrected
to the real identity. Trust `app.json` (`e8bcd802…`) over either.
