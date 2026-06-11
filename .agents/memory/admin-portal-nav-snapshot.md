---
name: Admin nav snapshot test
description: Adding/removing an admin-portal sidebar nav item breaks an exact-list unit test
---

Adding or removing an item in `buildNavGroups` (artifacts/admin-portal/src/pages/AppShell.tsx) breaks `src/pages/__tests__/navGroups.test.ts`, which asserts the **exact ordered href list** per group (e.g. the "hr" group). The `test` gate fails with a deep-equal diff even though the change is correct.

**Why:** the test is a regression snapshot of nav structure, not a behavior test.

**How to apply:** whenever you touch a nav group's items, update the matching `expect(...).toEqual([...])` array in navGroups.test.ts in lockstep. Fix = update the test, not the nav.
