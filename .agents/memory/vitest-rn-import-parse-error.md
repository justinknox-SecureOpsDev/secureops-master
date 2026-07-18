---
name: Vitest RN import parse error
description: Why security-ops vitest tests must not transitively import react-native, and how to keep helpers testable.
---

# Vitest can't parse react-native's `import typeof`

In `artifacts/security-ops`, a vitest test that (even transitively) imports
`react-native` fails at load with a Rollup parse error:
`Parse failure: Expected 'from', got 'typeOf'` pointing at
`react-native/index.js` (`import typeof * as ReactNativePublicAPI ...`). Vitest's
SSR transform / Rollup parser doesn't understand Flow's `import typeof` syntax.

**Why:** the test runner uses the Node/Rollup pipeline, not Metro+Babel, so the
Flow-typed RN entry is never stripped. Any module under test that pulls
`utils/api.ts`, `contexts/*`, or other RN-touching modules drags this in.

**How to apply:** keep pure, unit-testable logic in modules with **zero** React
Native / Expo imports and test those directly. Example: org-code parsing lives in
`utils/orgCode.ts` (RN-free); `utils/orgConfig.ts` (which imports `utils/api`,
i.e. RN) re-exports it for app use, but the test imports from `../orgCode`. The
vitest config (`vitest.config.ts`) aliases `@` → project root so `@/...` imports
resolve, but that alone won't save you — the imported module still must not reach
react-native.
