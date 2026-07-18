# Updating the live 1.0.2 app & connecting your WCSGI system (no App Store resubmission)

This is a plain-English runbook for two goals:

1. **Get your finished app into the hands of the people already running build 1.0.2** — without a new App Store / Play submission and the approval back-and-forth.
2. **Point that app at your completed WCSGI backend**, and (later) add more customers the same way.

It works because this app was built for *over-the-air (OTA) updates* (you ship new app code straight to installed phones) and for *multi-org* (one published app serves many separate customer backends, chosen by a short "organization code").

---

## Before you start — confirm 3 things (about 5 minutes)

Git confirms the app code is OTA-friendly (no new native pieces were added — only plain-JavaScript changes). The only things git **can't** see are facts about the actual binary sitting in the store. Confirm these in your **Expo (EAS)** and **Apple/Google** accounts:

1. **Open your EAS build dashboard → the 1.0.2 build.** Confirm:
   - **Project ID = `452c8467-1a26-4e16-9b41-e5799d80023e`**
   - **Channel = `production`**
   If both match, OTA updates you publish to `production` will reach that build.
2. **Note the bundle identifier that the 1.0.2 build used** (in App Store Connect / Play Console). Write it down — you need it for the "future native build" note at the bottom. (The code today says `com.secureopsmobilecommand.app`; the store build may have used an earlier name.)
3. **You won't be adding native features in this update.** OTA can only ship JavaScript/content, never new native modules. The current changes (multi-org routing, chat) are JavaScript, so you're fine.

If step 1 matches, proceed. If the project ID is different, the store build came from a different Expo project and OTA can't reach it — in that case you'd need one fresh native build, after which all future updates are OTA.

---

## Part A — Point the app at your completed WCSGI backend

Existing 1.0.2 installs automatically land on the organization code **`wcsg`**. So the simplest path is: make the `wcsg` code resolve to your finished WCSGI backend. Then existing users connect there with **no code to type**.

1. **Make sure your WCSGI backend is deployed and healthy** (its own database, API, admin/web, and branding).
2. **Set the `ORG_DIRECTORY` environment variable on your main "directory" deployment** (the canonical WCSG backend — the same origin the app uses by default). It is a JSON list of customers:

   ```json
   [
     { "code": "wcsg", "name": "Williams Council Security Group", "apiBaseUrl": "https://wcsgisecureops.com" }
   ]
   ```

   - `apiBaseUrl` is the **origin only** — `https://yourdomain.com`, with **no** `/api` and **no** trailing path.
   - Use your real WCSGI origin. (The app's built-in default origin is `security-operations-suite.replit.app`; point the `wcsg` entry at wherever your live WCSGI backend actually runs, e.g. `https://wcsgisecureops.com`.)
3. **Redeploy that directory deployment.** The org list is read once at boot and cached, so the change only takes effect after a redeploy.
4. **Verify** by opening this URL in a browser (replace the host with your directory deployment's host):
   `https://<directory-host>/api/org-directory/resolve?code=wcsg`
   You should get back `{"code":"wcsg","name":"...","apiBaseUrl":"https://wcsgisecureops.com"}`.

> An org code is only a *routing convenience* — it tells the app which backend to talk to. Each user still signs in with their real credentials on that backend.

---

## Part B — Push your finished app to existing 1.0.2 users (OTA)

This replaces the JavaScript inside the installed app. No store review, no resubmission.

> **Auto-OTA on republish (now wired in).** The Reserved-VM deploy build
> (`scripts/build-single-vm.mjs`) automatically runs `eas update --branch production`
> at the end of every republish — **if** an `EXPO_TOKEN` secret is present. Add your
> Expo access token (expo.dev → Account settings → Access tokens) as a Replit
> **Secret** named `EXPO_TOKEN`, and every future republish ships the latest mobile
> bundle to installed apps with no manual step. It's best-effort: a missing token is
> skipped, and an EAS hiccup is logged but never fails the server deploy. The manual
> commands below remain valid for one-off or out-of-band updates.

1. **Install the EAS tool and sign in** (one-time, on your computer):
   ```bash
   npm install -g eas-cli
   eas login
   ```
2. **From the mobile app folder, publish the update to the production channel:**
   ```bash
   cd artifacts/security-ops
   eas update --branch production --message "WCSGI launch build"
   ```
   - Keep the app **version at `1.0.2`** when you publish — that's what matches the installed build. (Don't bump it for an OTA-only release.)
   - If EAS says the `production` channel isn't linked to a branch, link it once:
     ```bash
     eas channel:edit production --branch production
     ```
3. **What users experience:** the next time someone opens the app, it quietly downloads the update in the background and applies it on the following launch. Within a day or two of normal use, everyone is on the new code — with no prompt and no store update.

**Optional safety step (recommended):** publish to the `preview` channel first and test on an internal build before doing `production`:
```bash
eas update --branch preview --message "WCSGI launch test"
```

---

## Part C — Add more customers later (same app, no resubmission)

For each new customer (example code `acme`):

1. Deploy their backend (own database, API, admin/web, branding).
2. Add a line to `ORG_DIRECTORY` on the directory deployment and redeploy:
   ```json
   [
     { "code": "wcsg", "name": "Williams Council Security Group", "apiBaseUrl": "https://wcsgisecureops.com" },
     { "code": "acme", "name": "Acme Security",                    "apiBaseUrl": "https://acme-backend-origin" }
   ]
   ```
3. Their staff open the **same** app, tap the Connect screen, and enter **`acme`**. Done — no new app-store submission, ever.

---

## Important: the one thing to fix before any FUTURE *native* build

OTA does **not** care about the app's bundle identifier — so the rename in the code doesn't block updating today's 1.0.2 users.

But the moment you build a **new native binary** (new SDK, new native feature, new icon baked in, etc.), the code's identifiers **must exactly match** the live store app, or Apple/Google treat it as a brand-new, separate app that can't update your existing listing.

- Your live App Store app id is `ascAppId 6773903231`.
- The code currently uses bundle id **`com.secureopsmobilecommand.app`** (iOS and Android).
- **Before any native build,** set `ios.bundleIdentifier` and `android.package` in `artifacts/security-ops/app.json` back to whatever the store's 1.0.2 build was registered under (the value you wrote down in pre-flight step 2).

If you'd like, I can make that bundle-id correction for you once you tell me the registered identifier from App Store Connect / Play Console.

---

## If something goes wrong (rollback an OTA)

OTA is reversible. In the EAS dashboard, open the previous good **update group** and choose **Republish**, or from the command line:
```bash
eas update:republish --group <previous-update-group-id>
```
Users return to the prior code on next launch. (Because OTA only swaps JavaScript, you can never "brick" the native app this way.)

---

## Command cheat-sheet

```bash
# one-time
npm install -g eas-cli
eas login

# publish finished app to existing 1.0.2 users
cd artifacts/security-ops
eas update --branch production --message "WCSGI launch build"

# (optional) test first
eas update --branch preview --message "WCSGI launch test"

# link channel to branch (only if EAS asks)
eas channel:edit production --branch production

# roll back
eas update:republish --group <previous-update-group-id>
```

**Org directory:** set `ORG_DIRECTORY` (JSON `[{code,name,apiBaseUrl}]`, origin-only URLs) on the directory deployment, then **redeploy** it.
