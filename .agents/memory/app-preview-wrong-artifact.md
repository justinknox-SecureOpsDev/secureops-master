---
name: app_preview hits the wrong artifact
description: In this multi-artifact monorepo, the agent's app_preview screenshot targets the default port (mockup-sandbox), not admin-portal/home/expo.
---

# app_preview screenshots the wrong artifact

This repo runs several dev servers on different ports (admin-portal, home,
api-server, mockup-sandbox, expo). The `app_preview` screenshot tool hits the
**default preview port** (externalPort 80), which here serves the
**mockup-sandbox** (it 302-redirects to `/__mockup`). So
`screenshot(app_preview, path="/admin-portal/")` fails with
`ERR_CONNECTION_REFUSED` / lands on the wrong app even though admin-portal is
healthy (it binds its own `PORT`, e.g. localhost:25580, base `/admin-portal/`).

The port-prefixed dev subdomain (`https://3001-<id>.<cluster>.replit.dev`) is
NOT externally served either — returns the "Run this app to see results"
placeholder.

**How to visually verify when app_preview won't reach the target:**
- Simplest rasterizer: ImageMagick 7 `magick` is on PATH WITH the librsvg
  delegate, so it renders gradient/stroke SVGs cleanly — no sharp install:
  `magick -density 300 -background none in.svg -resize 1024x1024 out.png`
  (app icons need opaque: add `-background "#080c18" -alpha remove -alpha off PNG24:icon.png`).
  Then `read` the PNG to eyeball it.
- Fallback: rasterize with sharp (hoisted under root `node_modules/.pnpm`, not
  the artifact's own `node_modules`, so require by absolute path or `find`):
  `node -e "require('/home/runner/workspace/node_modules/.pnpm/sharp@<ver>/node_modules/sharp')('/tmp/x.svg',{density:300}).png().toFile('/tmp/x.png')"`.
- Otherwise rely on the user's own preview pane (they pick the artifact's port),
  plus typecheck + the workflow HMR logs to confirm the bundle compiled.
