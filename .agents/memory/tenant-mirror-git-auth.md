---
name: Tenant fork fetch from private mirror needs a PAT, not the Git pane
description: Why `git fetch upstream` for the private secureops-master mirror fails with "Invalid username or token" in a tenant repl even after reconnecting GitHub, and the actual fix.
---

## Symptom
In a tenant's own repl, adding the private GitHub mirror as a second remote
(`git remote add upstream https://github.com/<org>/secureops-master.git`) and
running `git fetch upstream` fails with:

```
remote: Invalid username or token.
fatal: Authentication failed
```

This persists even after:
- Disconnecting/reconnecting GitHub in the repl's Git pane
- Confirming it's the same GitHub account across repls (no missing-collaborator issue)
- Confirming the installed GitHub App has "All repositories" access (no repo-scoping issue)

## Root cause
Replit's Git pane / GitHub App connection authenticates the repl's own **linked
"Version Control" remote** (the one used by the repl-to-GitHub sync UI feature).
It does **not** install a generic git-CLI credential helper that plain shell
`git fetch`/`git pull` can use against an arbitrary *second* remote. A manually
`git remote add`-ed remote (like `upstream` pointing at the private mirror)
never gets a working credential from that connection, no matter how many times
you reconnect or how broad the App's repo access is.

This is the same class of issue as pushing to the mirror from the *master*
repl's shell: the default askpass/credential helper doesn't work for git
commands run directly in bash; it only works through Replit's own managed
integration paths (e.g. the Connectors API, or the Git pane's own UI actions).

## Fix
Use a personal access token as a one-off credential helper, scoped to just
that command, so it never lands in `.git/config` or shell history:

1. Create a PAT (classic `repo` scope, or fine-grained scoped to the mirror
   repo, Contents:Read) on the GitHub account that owns/collaborates on the
   private mirror.
2. Store it as a Replit Secret in that repl (e.g. `GH_MIRROR_TOKEN`).
3. Fetch with:
   ```bash
   git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_MIRROR_TOKEN"; }; f' fetch upstream
   ```
4. `git merge upstream/main` afterward is local and needs no credential.

Repeat the same `-c credential.helper=...` prefix on every future
fetch/pull from the mirror in that repl — reconnecting the Git pane will not
fix it, because the pane was never the thing providing credentials to that
remote in the first place.

**Why:** saves re-diagnosing the same "reconnect GitHub" → "check repo access"
→ still fails loop on the next tenant update; the actual blocker is a
different, unrelated auth path.

**How to apply:** any time a *tenant* repl needs to `git fetch`/`pull` the
private `secureops-master` mirror as a second remote (per
`docs/update-existing-customer-runbook.md`), and the Git-pane connection looks
healthy but plain `git fetch` still 401s.
