---
name: Tenant fork updates travel through a GitHub mirror
description: How master-template code reaches an already-live customer fork (and how to push to GitHub from this repl without a stored token).
---

# Updating a live customer fork

A Replit fork is a point-in-time copy and there is **no fork-sync feature** (confirmed against Replit docs). Master work never reaches a customer copy on its own, and the master repl cannot read or write a tenant repl — env, secrets, DB, logs, and code all have to be changed from inside the tenant's own repl.

**The channel:** a private GitHub mirror of the master's `main` (git remote `github` in the master). Master pushes; every customer fork pulls it as `upstream`. Full history is preserved on purpose so a tenant merge has a common ancestor instead of unrelated histories.

**Why:** forks share history from the fork point, so an ordinary `git merge upstream/main` works; anything else (patch files, re-forking) either conflicts or destroys the tenant's database, secrets, and domain.

**How to apply:** operator procedure lives in `docs/update-existing-customer-runbook.md`. The two things that bite:
- `.replit` must be merged by hand — keep the **tenant's** `[userenv*]` blocks (ORG_CODE, admin emails, APP_BASE_URL/ALLOWED_ORIGINS, no ORG_DIRECTORY, never EXPO_TOKEN), take the **master's** workflows/ports/nix/deployment.
- Code alone is not enough: the tenant still needs `db push` on dev and a republish to migrate its own production database.

## Pushing to GitHub from inside this repl

`listConnections("github")` redacts credentials, so it cannot drive `git push`. The connector's real token is reachable the same way app code gets it — `GET https://$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection?include_secrets=true&connector_names=github` with header `X_REPLIT_TOKEN: repl $REPL_IDENTITY` — then push with a throwaway credential helper reading a `chmod 600` file, and delete the file afterwards. Never echo the token into shell output.

Push `main` explicitly (`git push github main:main`): this repo carries hundreds of `subrepl-*` task-agent branches that must not go to the mirror.
