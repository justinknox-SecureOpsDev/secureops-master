---
name: Orval codegen breaks Metro's resolver cache
description: Why the Expo app shows "Unable to resolve ./generated/api" after running OpenAPI codegen, and the fix.
---

After running `pnpm --filter @workspace/api-spec run codegen`, the Expo (security-ops) Metro bundler can start failing with `Unable to resolve "./generated/api" from "lib/api-client-react/src/index.ts"` — even though the generated files exist on disk and the admin-portal/api-server typechecks pass.

**Why:** orval's generation does a "Cleaning output folder" step that briefly deletes `lib/api-client-react/src/generated/` before rewriting it. Metro's in-memory haste/resolution cache observes the deletion and caches the resolve failure. Vite (admin-portal) recovers via HMR; Metro does not.

**How to apply:** after any codegen run, restart the `artifacts/security-ops: expo` workflow — a process restart clears Metro's in-memory resolver cache and the bundle recovers. Do not waste time hunting for a missing file; verify it exists, then just restart Metro.
