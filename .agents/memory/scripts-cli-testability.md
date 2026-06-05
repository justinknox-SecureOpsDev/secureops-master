---
name: scripts CLI testability
description: How to unit-test a scripts/ CLI without the top-level main() killing the test runner
---

# Testing scripts/ CLI files

The `scripts/` package CLIs (e.g. `check-schema-drift.ts`, `check-security-headers.ts`)
historically invoke `main()` at the top of the module. A `tsx --test` file that
imports their helpers would otherwise run `main()` on import and call
`process.exit`, killing the test runner mid-suite.

**Rule:** before importing helpers from a CLI script, guard its entrypoint:

```ts
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) { main().catch(...); }
```

**Why:** lets the same file be both a runnable CLI and an importable library of
pure helpers, so detection logic can be unit-tested directly.

**How to apply:**
- Cross-file imports inside `scripts/src` use the `.js` extension (e.g.
  `from "./check-schema-drift.js"`) — the package uses `moduleResolution: bundler`
  and tsc rejects `.ts` import extensions (TS5097); `.js` maps to the `.ts` source
  at both typecheck and tsx runtime.
- DB-requiring script tests must be their OWN validation gate (like
  `schema-drift` / `schema-drift-test`), NOT folded into the `test` gate, which is
  intentionally DB-free.
- Pattern for a DB-backed test: create a throwaway `pgSchema("drift_test_<pid>_<rand>")`,
  materialise objects, drive the real loaders + pure compare function, drop the
  schema on teardown. Assert exit behavior via the boolean helper main() uses
  (e.g. `hasAnyDrift`), not a subprocess.
