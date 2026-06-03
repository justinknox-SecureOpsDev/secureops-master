---
name: api-server dev has no hot reload
description: Why new/changed API routes 404 until the api-server workflow is restarted
---

The `@workspace/api-server` `dev` script is `build && start` (esbuild then run) — there is **no** file watcher / tsx-watch. The running process does not pick up new or changed route files automatically.

**Why:** A newly added route returns Express's default `Cannot GET/POST …` 404 even though the file is correct and typechecks, because the live process is still running the previously built bundle.

**How to apply:** After editing anything under `artifacts/api-server/src/` (routes, lib, middleware) — or after `db push` / `api-spec codegen` that the server imports — restart the `artifacts/api-server: API Server` workflow before curl/smoke-testing, or you'll chase phantom 404s.
