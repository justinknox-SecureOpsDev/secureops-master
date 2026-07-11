---
name: api-server vitest OOM under concurrent workflows
description: Why the full api-server test suite gets killed with no output, and how to run it green from the shell.
---

# api-server vitest OOM under concurrent workflows

Running the full api-server vitest suite from the shell while all dev workflows
are up (api-server dev, admin-portal vite, expo, mockup-sandbox) gets the process
**killed with exit code -1 and NO output** — it's an OOM, not a test failure.

Each api-server test file imports the whole Express app, so peak memory scales
with files run in parallel. `--no-file-parallelism` / single-worker flags did NOT
prevent the kill (and `--minWorkers` isn't a valid vitest 4 flag — use
`--maxWorkers`).

The same kill also hits the **admin-portal** vitest suite run whole (even with
`--maxWorkers=1`); its 8 files pass fine in 2–3 batches of explicit paths.

**How to apply:** run the suite in small batches of ~6 files via explicit paths,
e.g. `pnpm --filter @workspace/api-server exec vitest run src/__tests__/a.test.ts
src/__tests__/b.test.ts ...`. Payroll/invoice/chat files are the heaviest — keep
those batches smallest. A targeted single-file run (e.g. your new test) always
works. The standalone `test` workflow runs fine because it isn't competing with
the other workflows the same way.
