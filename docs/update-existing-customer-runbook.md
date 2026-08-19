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
| Database schema (new columns) | ⚠️ needs a schema push + republish — see steps 5 and 7 |
| Their data (officers, shifts, time entries, payroll) | untouched — it lives in their database |
| Their branding (company name, colors, logo, contact emails) | untouched — it lives in their database, not in code |
| Their secrets, storage bucket, custom domain, integrations | untouched |
| Their environment settings (`.replit` `[userenv*]` blocks) | **must be preserved by hand during the merge — step 3** |

## The one rule: a customer fork is read-only

A customer fork is a **downstream copy, not a workspace**. Code travels one way only — master → mirror → fork.

- **Never run agent tasks inside a customer repl.** Not for a quick fix, not for "just this one thing".
- **Never hand-edit code inside a customer repl.** The only file an operator touches there is `.replit`, and only its `[userenv*]` blocks.
- Everything a customer needs that is *not* code — company name, colors, logo, contact emails, feature toggles, rates, users, sites — is **data**. Change it in their admin portal, or remotely from the master Fleet Control Plane. Never in their code.
- If a customer genuinely needs a code change, build it in the master, push the mirror, and pull it down. That is the only path that leaves them updatable.

Why this is the whole ballgame: a fork that carries its own commits on shared files will **conflict** on the next update — and it conflicts in exactly the largest, most-shared route files. Hand-resolving those splices unrelated handler bodies together into interleaved fragments, and the wreckage still compiles and can still pass tests. That has already produced one branch nobody could safely publish. Step 4 below is the check that catches it.

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

   **A conflict in shared code is a stop sign, not a task.** The only file that should ever conflict is `.replit`. A conflict in application code — routes, components, schema, scripts, docs — does not mean the merge is hard; it means the fork carries local commits it should never have had. Do not resolve it by hand, and do not accept an editor's "smart" merge:

   ```bash
   git merge --abort
   ```

   Then take master's version of shared code **wholesale**, keeping only the customer's `[userenv*]` blocks by hand — that is "Recovering a fork that has already drifted" below. Splicing two versions of a route file together is what produced an unpublishable branch last time, and it typechecks.

3. **Resolve `.replit` by hand — this is the one file that matters.** Keep the **customer's** `[userenv]`, `[userenv.shared]`, and `[userenv.production]` blocks; take the **master's** version of everything else (`[[workflows]]`, `[[ports]]`, `[nix]`, `[deployment]`), since those carry real infrastructure changes. After resolving, confirm the customer's own values survived:
   - `ORG_CODE` — their code, not `wcsgi`
   - `DEMO_ADMIN_EMAIL` / `SUPER_ADMIN_EMAILS` — their admin
   - `APP_BASE_URL` / `ALLOWED_ORIGINS` — their domain (or absent, if they are still on `*.replit.app`)
   - `ORG_DIRECTORY` — must **not** be present in a customer copy
   - `EXPO_TOKEN` — must **never** exist in a customer copy (it would push phone-app updates to every other customer)

4. **Prove the fork is still an exact copy of master — run this immediately after the merge, before anything else:**
   ```bash
   pnpm --filter @workspace/scripts run check-fork-integrity
   ```
   This is the gate `typecheck` and the test suite cannot give you: it compares **content**, not compilability. It resolves the master revision this fork claims to be on — the fetched `upstream/main`, and only once that ref is an ancestor of HEAD, the same rule the deployed build identity applies — and then reports, in one run:

   - every tracked file whose content differs from that revision, **listed by path**. The customer's `.replit` is the one expected, allowed difference; anything else means the fork carries local code.
   - any leftover merge-conflict markers in tracked text files.
   - whether the environment still carries the customer's own `ORG_CODE` (not the master's `wcsgi`), with no `ORG_DIRECTORY` and no `EXPO_TOKEN`.

   It prints every finding at once and exits non-zero on any `FAIL`. **Do not continue past a FAIL.** Shared-code differences or conflict markers here mean the fork has drifted — go to "Recovering a fork that has already drifted" below; do not patch the listed files by hand.

5. **Install and sync the development database:**
   ```bash
   pnpm install
   pnpm --filter @workspace/db run push
   ```

6. **Last gate before publishing — all three must pass:**
   ```bash
   pnpm run typecheck
   pnpm -r --if-present run test
   pnpm --filter @workspace/scripts run check-fork-integrity
   ```
   Run the integrity check a second time here, after everything else is done. The install, the schema push, or a stray edit can dirty the tree between the merge and the publish, and a spliced route file sails through the first two commands.

7. **Republish (Reserved VM).** This is what migrates their **production** database. Additive changes (new nullable columns, new columns with defaults, new indexes) apply safely. A schema change that adds a *unique constraint* to a table that already has rows can fail validation or force a destructive rewrite — check the release notes for the batch before publishing, and never run DDL at boot.

8. **Verify against their live address and fleet status:**
   ```bash
   curl -s https://<their-address>/api/version      # build id should change
   curl -s https://<their-address>/api/brand        # still their name/colors
   ```
    Then sign in to `https://<their-address>/admin-portal/`, confirm no amber "degraded configuration" banner, and spot-check whatever the batch added. A brand-new endpoint answering `401` instead of `404` is the quick proof it shipped. In the master Fleet Control Plane, click **Poll now** and confirm the customer shows **up to date** against the automatically recorded master build. If it remains **behind**, the pull or republish did not reach the live backend; **never current** means it has not yet reported this master build.

9. **Re-run the config preflight** from a shell in the customer's repl:
   ```bash
   pnpm --filter @workspace/scripts run check-tenant-config
   ```
   Fix every `FAIL` before telling the customer they are updated.

## Recovering a fork that has already drifted

**Symptoms:** `check-fork-integrity` lists shared-code files as differing, the update conflicted in application code, or you know work was done inside that customer's repl at some point.

**The goal:** make the fork's *code* an exact copy of master again, and nothing else. Everything the customer owns lives outside the code tree, so none of the commands below can reach it:

| | |
|---|---|
| Their database (officers, shifts, time entries, payroll, branding, settings) | separate Postgres instance — untouched |
| Their Replit Secrets | not in git — untouched |
| Their object-storage bucket and uploaded files | not in git — untouched |
| Their custom domain and deployment settings | Replit-side config — untouched |
| Their `.replit` `[userenv*]` blocks | the one thing you restore by hand, below |

Run everything **inside the CUSTOMER's repl**.

1. **Take a checkpoint first**, from that repl's checkpoint list, so there is a way back.

2. **Save the customer's environment blocks before touching anything:**
   ```bash
   git show HEAD:.replit > /tmp/tenant-replit-backup.toml
   cat /tmp/tenant-replit-backup.toml
   ```
   Keep the printed copy somewhere outside the repl too — `/tmp` does not survive forever. Their `[userenv]`, `[userenv.shared]`, and `[userenv.production]` blocks are the only content in the whole tree worth preserving.

3. **Make sure the master is fetched and nothing is half-merged:**
   ```bash
   git merge --abort 2>/dev/null || true
   git fetch upstream
   ```

4. **Take master's code wholesale.** No hand-picking, no per-file resolution:
   ```bash
   git reset --hard upstream/main
   git clean -fd            # optional: drops untracked leftovers; ignores node_modules and other ignored paths
   ```
   This rewrites the repl's code tree only, and leaves HEAD exactly at the master revision — which is what makes the build identity and the integrity check agree afterwards.

5. **Put the customer's environment back.** Paste the saved `[userenv]`, `[userenv.shared]`, and `[userenv.production]` blocks into `.replit`, replacing master's. Take master's version of everything else in that file (`[[workflows]]`, `[[ports]]`, `[nix]`, `[deployment]`). Confirm their `ORG_CODE` (not `wcsgi`), their `DEMO_ADMIN_EMAIL` / `SUPER_ADMIN_EMAILS`, their `APP_BASE_URL` / `ALLOWED_ORIGINS`, **no** `ORG_DIRECTORY`, **no** `EXPO_TOKEN`. Then commit just that file:
   ```bash
   git add .replit && git commit -m "Restore tenant environment blocks"
   ```

6. **Re-verify:**
   ```bash
   pnpm --filter @workspace/scripts run check-fork-integrity
   ```
   Expect a clean pass with `.replit` as the only allowed difference. Any other path still listed means step 4 or 5 left something behind — repeat, do not patch it.

7. **Finish as a normal update** from step 5 of the procedure: `pnpm install` → `db push` → the step 6 gates → republish.

8. **Confirm the recovery on the live system:**
   ```bash
   curl -s https://<their-address>/api/version    # the recorded master revision now matches master's
   curl -s https://<their-address>/api/brand      # still their name, colors, contacts — proof nothing customer-owned was lost
   ```
   Then in the master Fleet Control Plane, click **Poll now**: the customer must show **up to date** against the recorded master build. **behind** means the reset or the republish did not reach the live backend.

If that customer needed something that only existed in their fork's local commits, it is a feature request against the master — build it there, push the mirror, and pull it down like any other update.

## The mobile app is separate

Officers all run one shared store app. Phone-side changes reach every customer by OTA from the **master only** — a customer fork never ships app updates (and must never hold an `EXPO_TOKEN`).

The practical consequence: a mobile feature can arrive on a customer's phones before their backend has the matching API. New client calls are written to fail quietly, so nothing breaks — the feature simply does nothing until that customer's backend is updated. Keep the gap short.

## Rollback

If an update goes wrong in a customer repl, roll that repl back to its checkpoint from before the merge, then republish. The master is unaffected — it is the source, not a participant.

---

## Quick reference

Master: merge work → `git push github main`.
Customer: `git fetch upstream` → `git merge upstream/main` → keep their `.replit` env blocks → **fork-integrity check** → `pnpm install` → `db push` → typecheck/test → **fork-integrity check again** → republish → verify `/api/version` → Fleet Control Plane says **up to date** → config preflight.

Both checks, run from a shell in the CUSTOMER's repl:
```bash
pnpm --filter @workspace/scripts run check-fork-integrity   # is this fork an exact copy of the master revision it claims?
pnpm --filter @workspace/scripts run check-tenant-config     # is this tenant's own config complete?
```

Never run agent tasks or hand-edit code in a customer repl. A conflict in shared code means `git merge --abort` and "Recovering a fork that has already drifted" — never a hand resolution.
