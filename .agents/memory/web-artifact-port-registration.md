---
name: Web artifact port must be registered
description: New web artifact workflow fails DIDNT_OPEN_A_PORT unless its localPort is in .replit [[ports]], even though vite binds and serves fine
---

A web artifact's `localPort` (in `artifacts/<name>/.replit-artifact/artifact.toml`) must correspond to a registered `[[ports]]` entry in `.replit`, or the workflow runner (River) reports `DIDNT_OPEN_A_PORT` on start — **even though vite actually binds the port and serves 200 locally** (`curl localhost:<port>/<base>/`).

**Why:** River's "is the service up" check keys off the registered port mapping, not just a local TCP listen. An unregistered port (e.g. an arbitrary one picked for uniqueness) makes River kill the process after the probe timeout. The captured `/tmp/logs` workflow log can still show vite "ready ... Local: http://localhost:<port>" because that's a stale snapshot from a prior run — it is NOT proof the current run is healthy.

**How to apply:**
- The set of usable ports is fixed by `.replit` `[[ports]]`. You CANNOT edit `.replit` directly (port mappings are owned by a separate mechanism; the edit tool refuses).
- Fix = point the artifact at an already-registered, currently-unused `localPort`. Each working artifact's port is in `[[ports]]`; find free registered ones by diffing the `[[ports]]` localPort list against every `artifact.toml` localPort.
- Change the port by writing `artifacts/<name>/.replit-artifact/artifact.edit.toml` (full desired toml, updating both `[services] localPort` and `[services.env] PORT`) then calling the `verifyAndReplaceArtifactToml({tempFilePath, artifactTomlPath})` callback in `code_execution`. Direct edits to `artifact.toml` are forbidden. vite reads `PORT`/`BASE_PATH` from `[services.env]`, so `vite.config.ts` needs no change.
- After the change, restart the workflow; verify with `curl localhost:<port>/<base>/` AND `curl https://$REPLIT_DEV_DOMAIN/<base>/` (preview-proxy screenshot can lag the port change with CONNECTION_REFUSED while the public domain already routes 200).
