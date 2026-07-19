---
name: Single-port Reserved VM publish for multi-artifact projects
description: How to make a multi-artifact (api + several web SPAs) project publishable as one always-on Reserved VM.
---

# Single-port Reserved VM publish

A Replit artifacts project that exposes many external ports (one per web
artifact) CANNOT publish as a Reserved VM: a VM allows exactly ONE external
port, and it must be external 80 mapped to the API's localPort. Autoscale is
not viable here because the API is stateful (in-process WS registry +
scheduled-job boot mutex).

**The fix:** have the api-server serve every web frontend itself, on one port.
Build each SPA with its URL base, copy the built assets into the api-server's
`dist/static/<base>`, and mount them AFTER `/api` with SPA history fallback +
bare->trailing-slash redirects. One combined build script wires this up and the
deploy `build`/`run` point at the single API bundle.

**Why these specific choices:**
- **`GET /` must return 200, not a 302.** The VM startup probe hits `/`; a 3xx
  there can fail the promote step. Serve a tiny 200 HTML shell that forwards via
  `<meta http-equiv="refresh">`. Do NOT use an inline `<script>` redirect — the
  production Helmet CSP is `script-src 'self'` and will block (and log) it.
- **Keep a marketing SPA off the root if it has routes that collide.** The
  `home` SPA is wouter with its own `/admin-portal` and `/officer-app` routes;
  mounting it at `/` collides with the real admin-portal mount. Keep it at
  `/home/` and forward `/` -> `/home/`.

**How to apply:** code can do the serving/build/env (deployConfig
target=vm/build/run, setEnvVars PORT + NODE_ENV=production). But the agent
CANNOT edit `.replit`: collapsing the `[[ports]]` list to a single
`externalPort=80 -> localPort=8080` and removing a leftover
`[deployment] router="application"` are user actions in the Publishing ->
Reserved VM -> Networking pane. There is no agent tool for port mapping.

**Build safety:** pnpm 10 does NOT prune `devDependencies` when
`NODE_ENV=production` is set (only the explicit `--prod`/`-P` flag does), so a
deploy-time `NODE_ENV=production` will still install vite/esbuild for the build.
(npm behaves differently — it omits devDeps under NODE_ENV=production.)

**Serving the Expo app's WEB export at a sub-path:** an Expo SPA can join the
single-port layout (e.g. at `/app/`) by running `expo export --platform web`
with the base path injected via a dynamic `app.config.js` that sets
`experiments.baseUrl` ONLY when an env var (e.g. `EXPO_WEB_BASE_URL`) is set —
this keeps dev `expo start`, EAS native builds, and OTA updates untouched
because those runs never set the var (build-script `run()` must pass extraEnv
per-child, never mutate `process.env`). Mount it exactly like the other SPAs
(bare→302, `express.static index:false`, HTML history fallback) but ADD an
asset-like guard (dot in final path segment → 404): script requests send
`Accept: */*`, which `req.accepts("html")` treats as HTML, so a stale hashed
bundle after a redeploy would otherwise get the HTML shell served as JS.
Expo's exported HTML satisfies a `script-src 'self'` CSP (one external script,
inline style only). Cover the new surface in the front-door gate with a FRESH
export — reusing a stale `web-dist` would mask a baseUrl regression.

**The real single-vs-multi-artifact switch is the COUNT of `deploymentTarget = "vm"`
artifacts, NOT `[deployment] router = "application"`.** A working single-port VM
publish kept `router = "application"` and the full `[[ports]]` list untouched the
whole time. What silently breaks it: adding a SECOND artifact with
`deploymentTarget = "vm"` (e.g. a control plane). With exactly one vm artifact the
project publishes in single-run mode (the `.replit [deployment].run`/`build:vm`
bundle serves marketing `/`, `/admin-portal/`, `/api`, `/api/ws` from one process).
With two+ vm artifacts the platform flips to multi-artifact mode: it launches EVERY
runnable artifact and waits for ALL their ports; any one that crashes at boot
(e.g. an artifact whose required prod env isn't set in this deployment) never opens
its port → "not all artifact ports opened" → SIGTERM restart loop → whole site 500s.
**Fix = keep api-server as the ONLY `deploymentTarget = "vm"` artifact.** Make any
secondary app dev-only (drop `deploymentTarget` AND `[services.production]`, keep
`[services.development]`); deploy it as its own separate Replit project instead.
Mobile (`kind="mobile"`) and static web (`kind="web"`) artifacts having
`[services.production]` is fine — they don't force multi-artifact mode; only the vm
target does. Gotcha: once a former vm artifact loses its target, its `previewPath`
must be made unique (e.g. `/__control-plane`) or it collides with another `/`
preview path (verifier: `DUPLICATE_PREVIEW_PATH`). Editing any `artifact.toml`
requires the `verifyAndReplaceArtifactToml` flow (write a sibling temp `.toml` in the
same `.replit-artifact/` dir, not `/tmp`), not a direct write.
