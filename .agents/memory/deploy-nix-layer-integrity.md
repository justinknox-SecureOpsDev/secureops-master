---
name: Deploy nix-layer integrity "sudden" failure
description: Why a previously-working publish suddenly fails at "verifying nix store path integrity before caching layer / corrupt nix store paths", and who owns the fix.
---

# Deploy fails caching nix-0: "corrupt nix store paths"

**Symptom:** A publish that succeeded before suddenly fails at the very end (after all
artifacts compile) with:
```
info: verifying nix store path integrity before caching layer
fatal: failed to push layers: nix layer integrity verification failed, refusing to cache:
corrupt nix store paths:
  …-nodejs-22.16.0:  expected sha256-A… got sha256-B…   (deterministic — same wrong hash every build)
  …-eas-cli-14.7.1:  expected sha256-C… got sha256-D…   (non-deterministic — differs each build)
```

**Trigger ("why all of a sudden"):** Replit's *cached* nix layer for the repl was
evicted, so the deployer rebuilds it from scratch for the first time and runs an
integrity check that the cached layer previously skipped. Compare build logs:
- Working builds say `info: Retrieved cached nix layer` (reused, no rebuild, no check).
- Failing builds say `info: Nix layers for this Repl are uncached.` → rebuild → integrity check → fatal.
The corruption was latent the whole time; the cold cache is just what exposes it.

**Whose paths:** `nodejs-22.16.0` + `eas-cli-14.7.1` come from the `security-ops`
Expo artifact's `[[integratedSkills]] name = "expo"` managed toolchain — NOT from
`replit.nix` (only lsof/iproute2/chromium) or `.replit` modules (nodejs-24/python/postgres).
The user cannot edit these derivations.

**Why it's Replit-side:** deterministic node-22 mismatch = stale expected-hash in
Replit's nix cache; non-deterministic eas-cli = non-reproducible derivation. The app's
own build is fine (local `NODE_ENV=production … run build` passes; deploy logs show all
artifacts compiling). Reproduced identically across builds an hour apart.

**How to apply:**
- Do NOT advise "just retry" once it has reproduced — it's not a flake.
- Correct owner is Replit support: ask them to clear/rebuild the corrupt managed Expo
  toolchain entries in their nix cache. Hand them the failing build IDs + the exact
  `corrupt nix store paths` line.
- The live site stays UP on the last successful build in the meantime (autoscale serves
  the prior image); confirm with getDeploymentInfo `hasSuccessfulBuild:true` + curl
  `/api/healthz` + `/`.
- Possible user-side workaround if the native app ships OFF Replit (App Store): strip the
  native-build tooling (`eas-cli`, used only for native build/submit) so that corrupt path
  isn't pulled. NOT guaranteed — `nodejs-22.16.0` is still used by `expo export --platform web`
  to build the web version served at `/`, so the node-22 corruption can persist.
