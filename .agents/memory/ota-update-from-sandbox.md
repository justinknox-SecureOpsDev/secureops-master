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
runtime version, NOT bundle/ASC ids directly — but the production channel's
finished builds ARE `com.secureopscommand.mobile` / ASC app 6789409652
(runtime `1.0.0`, policy `appVersion`, so never bump `expo.version` for an
OTA-only release). `artifacts/security-ops/OTA_RELEASE_RUNBOOK.md` is STALE
(references the retired EAS project `452c8467…` and version 1.0.2); trust
`app.json` (`e8bcd802…`, 1.0.0) instead.
