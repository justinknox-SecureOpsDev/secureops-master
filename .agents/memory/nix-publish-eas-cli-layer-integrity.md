---
name: Dev-only nix packages break VM publish
description: A VM publish can fully build yet fail at Replit's "push Nix layers" step on a corrupt/broken dev-only nix system package; remove it, don't retry.
---

# Dev-only nix packages break VM publish (nix layer integrity)

A Reserved-VM publish can compile **every** artifact successfully and still fail at the very end, during Replit's infrastructure step that pushes/caches the Nix image layers:

```
fatal: failed to push layers: nix layer integrity verification failed, refusing to cache:
corrupt nix store paths: /nix/store/...-eas-cli-14.7.1:
expected sha256-..., got sha256-...
```

**Root cause:** a dev-only Nix system package declared in `.replit [nix].packages` (here `eas-cli`, also stray `yakut`) is part of the deploy image and its store path fails integrity verification. A **reproducible** `expected/got` sha256 mismatch across builds means the package *in that nix channel* is broken — it is NOT transient local corruption, so retrying the same publish fails again.

**Why:** mobile-build tooling (`eas-cli`) and unrelated CLIs (`yakut`) have no place in the *server* runtime image. The project already pins a newer `eas-cli` as a pnpm devDependency in `artifacts/security-ops`, which is what's actually used for `eas init`/`eas build`. The Nix copy only bloats the image and adds a failure surface.

**How to apply:**
- Fix = REMOVE the offending dev/unused packages from `.replit [nix].packages`, not retry. Do it with `uninstallSystemDependencies({ packages: [...] })` from the package-management skill — **direct edits to `.replit` are blocked** (the file is owned by per-setting tools).
- **WARNING — the agent uninstall can be a silent no-op.** Observed in this repl: `uninstallSystemDependencies` returns `success` *every time* (incl. after a workspace reload + `restart_workflow`) yet `.replit [nix].packages` is NEVER updated and `which <bin>` still resolves the corrupt nix-store path. A subsequent publish then reproduced the **identical** expected/got sha256 → the deploy snapshots the stale on-disk `.replit` + the corrupt local store, NOT any config-service state the tool claims to have updated. So a green "success" from the tool is NOT proof the package left the image — always verify `.replit` + PATH afterward, and do not suggest publishing until they actually change.
- When the agent tool won't sync, the reliable fixes are USER actions the agent can't perform: (a) remove the package via the Replit **Dependencies / System Dependencies (Nix)** UI panel, which forces a real environment rebuild + reload; or (b) contact Replit support to clear the corrupt `/nix/store/...` path / force the sync. `nix-store --verify-path`/`--repair-path` from the agent shell just hangs (no substituter reachable), so don't rely on it.
- Also unrelated but adjacent: the default Replit `pyproject.toml` scaffolding (`requires-python`) can break the deploy's `uv lock` step if it pins a Python newer than the provisioned module — align it to the installed version.
