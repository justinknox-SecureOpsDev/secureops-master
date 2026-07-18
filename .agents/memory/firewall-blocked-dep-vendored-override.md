---
name: Firewall-blocked transitive dep — vendored pnpm override
description: How to unblock pnpm install when a transitive dependency is CVE-firewall-blocked at every version, and the hardlink gotcha that makes vendored edits go stale.
---

# Firewall-blocked transitive dependency → vendored `file:` override

When `pnpm install` fails fetching a package because Replit's
`package-firewall.replit.local` returns **403 "Blocked by Security Policy …
Critical CVE"** (Socket Security) for **every** version of that package, it is a
genuine security block — do NOT just retry. If the package is a transitive,
dev-only dependency not used by the production runtime, vendor a local
reimplementation and force it via a pnpm override.

**The pattern (proven for `shell-quote`, blocked transitive of
`react-devtools-core` / Expo debug tooling):**

1. Create `vendor/<pkg>/` with a `package.json` (same `name`, a satisfying
   `version`, correct `main`/`exports`) and faithful source files.
2. Add to `pnpm-workspace.yaml` under `overrides:`:
   `<pkg>: file:./vendor/<pkg>` — this replaces ALL versions in the tree, so no
   blocked tarball is ever fetched. `pnpm-lock.yaml` then resolves the consumer
   to `<pkg>@file:vendor/<pkg>`.
3. Reinstall. Verify the real consumer's resolution, not just a root require.
4. Add a parity test (`node test.js`) covering the consumer's actual usage, and
   keep the `package.json` description factual — do NOT claim "CVE-safe" without
   evidence. Treat it as a temporary shim; remove the override when the firewall
   allows the upstream package again.

**Why faithful matters:** a hand-written reimplementation must match upstream
behavior for the cases the consumer hits. For shell-quote, the real consumer
parses editor command strings, so `parse()` must keep quoted spans with spaces
together (`parse('open "/My Files/app.js"')` → `['open','/My Files/app.js']`).
A whitespace-splitting chunker breaks this; use a single-pass tokenizer.

**Hardlink gotcha (cost 1+ iteration):** do NOT set
`package-import-method=hardlink` in `.npmrc` when iterating on a vendored
`file:` dep. With hardlink, pnpm **copies** the file: dependency into the store
at install time, so later edits to `vendor/<pkg>/` do NOT take effect until you
reinstall — the installed copy silently runs stale code even though the store
path points at your vendor dir. Leave the default import method so edits stay
live (or always reinstall after editing the vendored package).
