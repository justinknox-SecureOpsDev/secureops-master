# Updating an Existing Customer Backend — SecureOps

**Goal:** move features that were merged into the master template into a customer's already-live fork, without touching their data, branding, or settings.

**Why this needs a procedure:** a fork is a point-in-time copy. Replit has no "sync with the original" button, so work done in the master never reaches a customer copy on its own. The channel is a **private GitHub mirror of the master**: the master pushes, each customer pulls.

---

## The channel (set up once — already done)

- Private repo: **`justinknox-SecureOpsDev/secureops-master`** — a mirror of this project's `main` branch, full history.
- This project has it as the git remote `github`. After a batch of work is merged here, push it:
  ```bash
  git push github main
  ```
- Nothing in the running fleet reads this repo. It exists only so customer copies have something to pull from.
- The mirror is **private**. Keep it that way — it is the whole product.

## What a pull changes, and what it cannot touch

| | |
|---|---|
| Code, features, tests, docs | ✅ updated by the pull |
| Database schema (new columns) | ⚠️ needs a schema push + republish — see steps 4 and 6 |
| Their data (officers, shifts, time entries, payroll) | untouched — it lives in their database |
| Their branding (company name, colors, logo, contact emails) | untouched — it lives in their database, not in code |
| Their secrets, storage bucket, custom domain, integrations | untouched |
| Their environment settings (`.replit` `[userenv*]` blocks) | **must be preserved by hand during the merge — step 3** |

## Procedure — run inside the CUSTOMER's repl, never the master

1. **Point the customer repl at the mirror** (first update only):
   ```bash
   git remote add upstream https://github.com/justinknox-SecureOpsDev/secureops-master.git
   ```
   For a private repo the repl needs GitHub access: connect the account in that repl's Git pane, or add the GitHub integration there.

2. **Fetch and merge:**
   ```bash
   git fetch upstream
   git merge upstream/main
   ```
   Both repos share history from the fork, so this is an ordinary merge. If something goes wrong before you commit, `git merge --abort` puts everything back.

   The backend build records the fetched `upstream/main` revision, not the customer's merge-commit SHA. That gives the Fleet Control Plane a common master revision to compare even when the merge creates a customer-specific commit.

3. **Resolve `.replit` by hand — this is the one file that matters.** Keep the **customer's** `[userenv]`, `[userenv.shared]`, and `[userenv.production]` blocks; take the **master's** version of everything else (`[[workflows]]`, `[[ports]]`, `[nix]`, `[deployment]`), since those carry real infrastructure changes. After resolving, confirm the customer's own values survived:
   - `ORG_CODE` — their code, not `wcsgi`
   - `DEMO_ADMIN_EMAIL` / `SUPER_ADMIN_EMAILS` — their admin
   - `APP_BASE_URL` / `ALLOWED_ORIGINS` — their domain (or absent, if they are still on `*.replit.app`)
   - `ORG_DIRECTORY` — must **not** be present in a customer copy
   - `EXPO_TOKEN` — must **never** exist in a customer copy (it would push phone-app updates to every other customer)

4. **Install and sync the development database:**
   ```bash
   pnpm install
   pnpm --filter @workspace/db run push
   ```

5. **Check it builds and passes before publishing:**
   ```bash
   pnpm run typecheck
   pnpm -r --if-present run test
   ```

6. **Republish (Reserved VM).** This is what migrates their **production** database. Additive changes (new nullable columns, new columns with defaults, new indexes) apply safely. A schema change that adds a *unique constraint* to a table that already has rows can fail validation or force a destructive rewrite — check the release notes for the batch before publishing, and never run DDL at boot.

7. **Verify against their live address and fleet status:**
   ```bash
   curl -s https://<their-address>/api/version      # build id should change
   curl -s https://<their-address>/api/brand        # still their name/colors
   ```
    Then sign in to `https://<their-address>/admin-portal/`, confirm no amber "degraded configuration" banner, and spot-check whatever the batch added. A brand-new endpoint answering `401` instead of `404` is the quick proof it shipped. In the master Fleet Control Plane, click **Poll now** and confirm the customer shows **up to date** against the automatically recorded master build. If it remains **behind**, the pull or republish did not reach the live backend; **never current** means it has not yet reported this master build.

8. **Re-run the preflight** from a shell in the customer's repl:
   ```bash
   pnpm --filter @workspace/scripts run check-tenant-config
   ```
   Fix every `FAIL` before telling the customer they are updated.

## The mobile app is separate

Officers all run one shared store app. Phone-side changes reach every customer by OTA from the **master only** — a customer fork never ships app updates (and must never hold an `EXPO_TOKEN`).

The practical consequence: a mobile feature can arrive on a customer's phones before their backend has the matching API. New client calls are written to fail quietly, so nothing breaks — the feature simply does nothing until that customer's backend is updated. Keep the gap short.

## Rollback

If an update goes wrong in a customer repl, roll that repl back to its checkpoint from before the merge, then republish. The master is unaffected — it is the source, not a participant.

---

## Quick reference

Master: merge work → `git push github main`.
Customer: `git fetch upstream` → `git merge upstream/main` → keep their `.replit` env blocks → `pnpm install` → `db push` → typecheck/test → republish → verify `/api/version` → Fleet Control Plane says **up to date**.
