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

**CRITICAL — runtimeVersion targeting:** OTA reaches installed builds by EAS
project + channel + runtime version, NOT bundle/ASC ids directly. Policy is
`appVersion` so runtimeVersion = `expo.version` at export time.

- App Store installed base (verified July 24 2026 via `eas build:list`): ALL
  store builds (1–10, incl. live build 10) are **runtime "1.0.0"** — an earlier
  note here claiming "1.0 build 9" was WRONG ("1.0" ≠ "1.0.0"; exact string
  match), and an update pushed at "1.0" reached zero devices. Always confirm
  the runtime with `eas build:list` / `eas build:view`, never from memory.
- Repo `app.json` is back at `1.0.0` so auto-OTAs-on-deploy reach real devices
  again; bump to `1.0.1` only WHEN the new native binary is actually built
  (see RADIO_NATIVE_RELEASE_RUNBOOK.md §1).
- Auto-OTA-on-deploy exports from the DEPLOY SNAPSHOT's app.json, not HEAD —
  a version fix committed after the deployed commit doesn't take effect until
  the next republish, so deploys kept publishing phantom-runtime updates.
  After any deploy, sanity-check `eas update:list --branch production` runtime
  against `eas build:list`; if they diverge, push a manual OTA from HEAD.
- Native-compat guard: build 10 has LiveKit natives but NOT expo-audio; builds
  ≤9 have NEITHER. All native deps newer than the oldest served binary must be
  loaded via guarded lazy require — LiveKit via
  `components/radio/nativeModules.ts` (`getLiveKitNative()` /
  `getLiveKitWebRTC()`; radio degrades to presence-only). expo-audio currently
  has NO loader at all (its keep-alive was reverted July 25, 2026 with the
  radio rollback) — it stays in BINARY_GATED_NATIVE_PACKAGES with an empty
  allow-list, so re-adding it requires a new guarded loader. Any NEW native
  dep must get the same guard (or a real runtime bump) before 1.0.0 OTAs.
- **`livekit-client` (pure JS!) is ALSO gated**: its module eval touches
  `DOMException` etc., which exist on Hermes only after registerGlobals() —
  a static value import crashes EVERY native binary at route registration
  (release builds die to springboard). Load only via `getLiveKitClient()`
  (which forces getLiveKitNative() first); `import type` is the only safe
  top-level form. Rule of thumb: "ships in the bundle" ≠ "eval-safe on
  Hermes" — any browser-targeting JS lib can hide the same trap. The gated list (`BINARY_GATED_NATIVE_PACKAGES` in
  nativeModules.ts) is ENFORCED by `__tests__/binaryGatedNativeImports.test.ts`
  — static value imports outside the approved loader fail the test gate; add
  new binary-gated deps to that list. Test note: vitest `vi.mock` does NOT
  intercept bare CJS `require()` — use the `__setNativeRequireForTest()` seam
  in nativeModules.ts.
- Never bump `expo.version` for an OTA-only release; it silently orphans the OTA.
- Verify what devices are served: `curl https://u.expo.dev/<projectId>` with
  headers expo-platform / expo-runtime-version / expo-channel-name:production /
  expo-protocol-version:1 → check `expo-update-id` response header.

`artifacts/security-ops/OTA_RELEASE_RUNBOOK.md` is STALE (retired EAS project
`452c8467…`, wrong versions); `RADIO_NATIVE_RELEASE_RUNBOOK.md` was corrected
to the real identity. Trust `app.json` (`e8bcd802…`) over either.
