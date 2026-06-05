---
name: security-headers gate dist race
description: Why the security-headers validation gate intermittently fails with "Cannot find module dist/index.mjs"
---

The `security-headers` validation gate builds api-server to `artifacts/api-server/dist/index.mjs`, then `check-security-headers.ts` spawns that built server and waits for it to answer on a port.

**Symptom:** the gate's own build step succeeds, but the spawned child immediately exits code 1 with `Cannot find module '.../artifacts/api-server/dist/index.mjs'`, followed by `Server did not respond on port ... within 15000ms`.

**Why:** the api-server **dev** workflow (`pnpm run dev` → `pnpm run build` → esbuild) is usually running at the same time and rebuilds into the *same* `dist/`. esbuild's build clears/replaces `dist` mid-flight, so between the gate's build finishing and its spawn starting, the file is briefly gone. It is a concurrency race on a shared output dir, NOT a code defect in api-server or whatever change is being validated.

**How to apply:** if a scripts-only / unrelated change "fails" only the security-headers gate with this exact module-not-found message while `typecheck`, `test`, `schema-drift` all pass, treat it as the dev-workflow dist race and skip/ignore it — don't chase it in api-server code. A real fix would isolate the gate's build output dir (or stop the dev workflow before the gate builds).
