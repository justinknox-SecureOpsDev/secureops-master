---
name: Deploy nix-layer integrity "sudden" failure
description: Why a previously-working publish suddenly fails at "verifying nix store path integrity before caching layer / corrupt nix store paths", and the actual fix.
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

**Actual root cause (confirmed by the fix):** the corrupt paths came from an explicit
`[nix]` block in `.replit`:
```
[nix]
channel = "stable-25_05"
packages = ["yakut", "eas-cli"]
```
The `eas-cli` nix package (resolved to `eas-cli-14.7.1` on that channel) is a
non-reproducible derivation AND it pulls in `nodejs-22.16.0` as its Node runtime
dependency (the app itself runs on the nodejs-24 `.replit` module, so node-22 was ONLY
there for eas-cli). So BOTH corrupt paths traced back to this one package. NOTE: do not
assume these come from the Expo `[[integratedSkills]]` toolchain — check `.replit`
`[nix].packages` first.

**Fix that worked:** remove the offending package(s) from `.replit` `[nix].packages`
(set to `[]` here — `yakut` was also unused). Removing `eas-cli` also dropped its
`nodejs-22.16.0` dep, so the next publish rebuilt the nix layer with neither corrupt path
and succeeded. It was SAFE because nothing used the nix `eas-cli`: the Expo
`submit:ios` script uses the **npm-installed** eas-cli (`./node_modules/.bin/eas`, v18),
not the nix one. Editing `.replit` `[nix]` reloads the workspace env (restarts workflows
→ transient 502s); restart the api-server workflow to recover dev.

**How to apply:**
- Don't advise "just retry" once it has reproduced — it's not a flake.
- First look at `.replit` `[nix].packages` for an unused / non-reproducible CLI tool
  (eas-cli, etc.) and its transitive runtime (a node version that isn't your module).
  Remove what the build doesn't actually use (verify with a grep for bare-binary usage vs
  the npm-installed equivalent). This is user-fixable and was the real fix here.
- Replit support (clearing their cache) is the fallback if the corrupt path is genuinely
  from a managed layer you can't edit — but check `.replit` first.
- The live site stays UP on the last successful build while builds fail (autoscale serves
  the prior image); confirm with getDeploymentInfo `hasSuccessfulBuild:true` + curl
  `/api/healthz` + `/`.
