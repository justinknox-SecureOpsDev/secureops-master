---
name: res.sendFile under a dot-dir 404s
description: Why a dot-prefixed build/output dir makes Express res.sendFile() 404 while express.static still serves assets fine.
---

`res.sendFile(absolutePath)` runs the **full absolute path** through the `send`
library, whose default `dotfiles: "ignore"` rejects ANY path containing a
dot-segment (a path component starting with `.`, e.g. `.fdbg`,
`.frontdoor-build-XXyy`). The result is a `NotFoundError: Not Found` 404 thrown
from inside `send`, even though the file is present on disk.

`express.static(root, …)` does NOT hit this for the same files, because its
dotfile check runs against the **request sub-path relative to `root`**, not the
`root` itself — so a dot-segment that lives in `root` (the mount dir) is
invisible to the check. This is why, in a dot-prefixed build dir, hashed
`/assets/*.js` serve 200 (express.static) while every SPA history-fallback
(`res.sendFile(indexHtml)`) 404s.

**Why:** building the single-port front-door CI gate
(`scripts/src/check-front-door.ts`) into a `.frontdoor-build-*` temp dir made
`GET /`, `/pricing`, `/admin-portal/` all 404 while assets stayed 200 — a
confusing split that took several passes to pin on `send`'s dotfiles default,
not on route order, `req.accepts`, esbuild bundling, or path resolution.

**How to apply:** any test harness / tooling that boots the bundle and exercises
`res.sendFile` history-fallbacks MUST use a build/output dir whose path has **no
dot-segment** (e.g. `frontdoor-build-*`, not `.frontdoor-build-*`). Production is
safe because it serves from `dist/static` (no dot). The security-headers gate
gets away with a `.secheaders-build-*` dot dir only because it never calls
sendFile (it hits `/api/*` JSON only). If you ever need a dot dir AND sendFile,
pass `{ dotfiles: "allow" }` to sendFile — but prefer just not using a dot dir.
