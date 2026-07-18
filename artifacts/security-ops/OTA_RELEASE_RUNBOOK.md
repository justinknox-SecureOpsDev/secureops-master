# OTA Release Runbook — Multi-Org Update

This runbook describes how to ship the **multi-org mobile feature** to the
already-approved iOS build (version `1.0.2`) as an over-the-air (OTA) EAS Update
on the `production` channel.

The multi-org change is **pure JavaScript** — it adds no new native modules — so
it can be delivered as an OTA bundle to the installed `1.0.2` build. **No new App
Store submission is required.**

---

## ⛔ HOLD — DO NOT PUBLISH YET

**Do not publish this OTA update until Apple has issued the _final release_ of the
`1.0.2` build.** Publishing before the build is fully released risks pushing a JS
bundle at a binary that is still in review.

Before publishing, confirm in the [EAS dashboard](https://expo.dev/) that the
`1.0.2` build:

1. Was **compiled with `expo-updates` baked in** (the build's detail page lists an
   `expo-updates` runtime and a configured update URL).
2. Shows **runtime version `1.0.2`** (driven by the `appVersion` policy in
   `app.json`).
3. Is tied to the **`production` channel**.

> If `expo-updates`/OTA support was added to the config _after_ this build was
> compiled, the installed binary cannot receive OTA updates. In that case a single
> fresh submission is required once to "arm" OTA, after which all future JS-only
> changes ship over the air.

When all three are confirmed **and Apple's final release of `1.0.2` is live**,
proceed below.

---

## Preconditions

| Check | Expected value | Where |
| --- | --- | --- |
| App version | `1.0.2` | `app.json` → `expo.version` |
| Runtime version policy | `appVersion` (→ runtime `1.0.2`) | `app.json` → `expo.runtimeVersion.policy` |
| Update URL | `https://u.expo.dev/452c8467-1a26-4e16-9b41-e5799d80023e` | `app.json` → `expo.updates.url` |
| Store build channel | `production` | `eas.json` → `build.production.channel` |
| EAS project id | `452c8467-1a26-4e16-9b41-e5799d80023e` | `app.json` → `expo.extra.eas.projectId` |
| Apple `1.0.2` final release | Live in App Store Connect | App Store Connect |

The OTA update is matched to the installed binary by **runtime version**. Because
the runtime version policy is `appVersion`, the runtime version equals the app
`version` (`1.0.2`). An update only reaches a device whose installed build has the
**same runtime version** and is listening on the **same channel** (`production`).

## The don't-bump-version rule

**Leave `expo.version` at `1.0.2`. Do not bump it for this OTA release.**

Because `runtimeVersion.policy` is `appVersion`, changing `version` (e.g. to
`1.0.3`) changes the **runtime version**. A `1.0.3` update would no longer match
the installed `1.0.2` build, so the OTA bundle would be invisible to every device
in the field. Version bumps are only for new native builds / store submissions —
not for OTA JS updates.

## Publish step

From the mobile app directory (`artifacts/security-ops/`), publish the JS bundle
to the **`production`** channel — the same channel the store build is tied to in
`eas.json`:

```bash
cd artifacts/security-ops
eas update --channel production --message "Multi-org support (org code connect + native org switch)"
```

Notes:
- Use a clear, specific `--message` so the update is identifiable in the EAS
  dashboard and rollback list.
- Publishing to `production` is what makes the bundle visible to installed
  `1.0.2` builds; `preview`/`development` channels do not reach store installs.
- Do **not** run `eas build` or `eas submit` for this release — it is OTA-only.

## Expected behavior after publish

- Existing **logged-in** installs auto-migrate to the `wcsg` org on next launch
  and are **NOT** bounced to the `/connect` screen. (The app maps legacy
  single-tenant installs to org `wcsg` via `LEGACY_DEFAULT_ORG`, so an update never
  strands a logged-in user.)
- New / logged-out installs see the org-code connect flow as designed.
- The update is applied on the **next cold launch** after the device downloads it
  (standard `expo-updates` fetch-on-launch behavior).

## Verification

1. **Confirm the update is live on the channel:**
   ```bash
   eas update:list --channel production
   ```
   The newest entry should show your update message and runtime version `1.0.2`.

2. **Confirm a device picks it up:** on a test device running the installed
   `1.0.2` build, fully background/quit the app and relaunch it (twice if needed —
   `expo-updates` downloads in the background on one launch and applies on the
   next). Verify the multi-org behavior is present and that a previously logged-in
   user lands on their home screen (auto-migrated to `wcsg`), not `/connect`.

## Rollback

If the new bundle misbehaves, roll back by **republishing a known-good prior
update** to the same channel and runtime version. OTA rollback is a roll-_forward_
to an older bundle.

1. List recent updates / groups to find the last-good one:
   ```bash
   eas update:list --channel production
   ```
2. Republish that prior update group to `production`:
   ```bash
   eas update:republish --group <GOOD_UPDATE_GROUP_ID>
   ```
   (Alternatively, roll out the prior update via
   `eas channel:edit production --branch <branch>` if you publish per-branch.)
3. Verify with `eas update:list --channel production` and a test-device relaunch,
   exactly as in **Verification** above.

Because OTA only swaps the JS bundle, rollback requires no rebuild and no store
action — it takes effect on the next device launch.

---

### Scope reminder

This task **documents** the procedure only. As part of producing this runbook,
**no OTA update is published and no app version is bumped.** The actual publish is
a manual step run by the release owner with their Expo credentials, **only after**
Apple's final release of the `1.0.2` build.
