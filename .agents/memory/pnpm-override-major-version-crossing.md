---
name: pnpm override crosses major version unexpectedly
description: A bare/unbounded pnpm override (no upper bound) can resolve a dependency past the intended major version, breaking peers that need internal APIs from the older major.
---

When forcing a vulnerable transitive dependency to a "safe" version via a
`pnpm-workspace.yaml` `overrides` entry, an override value with **no upper
bound** (e.g. `pkg: '>=X.Y.Z'`) lets pnpm resolve to the newest version
satisfying that range across the whole workspace — which can silently jump
a major version for consumers that need the older major's internals.

**Why:** `undici: '>=7.28.0'` (meant to patch a 7.x CVE) resolved some
undici consumers to 8.7.0 instead of a patched 7.x. jsdom 29.x's own
require graph does `require('undici/lib/handler/wrap-handler.js')`, a file
that only exists in the undici 7.x tree (renamed/removed in 8.x), so every
vitest suite using jsdom failed with `MODULE_NOT_FOUND` — even though the
override "worked" (no more vulnerable version present) and `pnpm audit`
was clean.

**How to apply:** When patching a vulnerability via a version-range
override, bound the override to the same major line as the vulnerable
version whenever a newer major exists (e.g. `'>=7.28.0 <8.0.0'`), unless
you've confirmed every consumer's declared peer/dep range already spans
the newer major. After any dependency-override change, actually run the
consuming test suites (not just `pnpm audit` / `pnpm install` exit code) —
a clean audit does not guarantee the resolved graph still boots.
