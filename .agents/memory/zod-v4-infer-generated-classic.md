---
name: zod v4 z.infer on generated classic schemas
description: Why z.infer collapses to unknown on orval-generated zod and how to type it
---

Rule: when typing values from the orval-generated zod schemas (`lib/api-zod`), do not use the workspace's default `z.infer` — it can collapse to `unknown`. Import the classic type namespace instead: `import type { z as zClassic } from "zod"` and use `zClassic.infer<typeof schema>`.

**Why:** the workspace resolves `zod` to v4, whose `z.infer` expects v4 schema internals; orval emits classic (v3-style) schemas, so v4's `infer` sees no matching structure and yields `unknown`, silently killing type safety on server-side validation results.

**How to apply:** any server code that derives a TS type from a generated zod schema (e.g. request-body validation in api-server routes) must use the `zClassic.infer` pattern; typecheck stays green either way only if the `unknown` never flows into a typed position, so verify the inferred type is concrete.
