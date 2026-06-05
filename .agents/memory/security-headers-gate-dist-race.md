---
name: security-headers gate dist race (fixed)
description: The security-headers gate used to flake with "Cannot find module dist/index.mjs"; it now builds/spawns from its own isolated dir
---

**Status: fixed.** The `security-headers` gate now builds the api-server into a private `artifacts/api-server/.secheaders-build-*` dir (via the `API_SERVER_OUT_DIR` override in `build.mjs`) and spawns from there, so it no longer shares `dist/` with the running dev workflow. The validation command is just `check-security-headers` (the script does its own build); the old `... run build && ...` prefix was dropped.

**Historical symptom (pre-fix):** the gate's build succeeded, then the spawned child exited code 1 with `Cannot find module '.../artifacts/api-server/dist/index.mjs'`, followed by `Server did not respond on port ... within 15000ms`. Cause was a concurrency race: the api-server **dev** workflow rebuilds the *same* `dist/` and esbuild clears it mid-flight.

**Gotcha for the fix:** the isolated build dir MUST live inside `artifacts/api-server/` (not `os.tmpdir()`), because the bundle externalizes native deps (pdfkit, sharp, bcrypt, …) that only resolve via the api-server `node_modules` chain — spawning from `/tmp` fails with `ERR_MODULE_NOT_FOUND: pdfkit`.
