---
name: deepLinkFocus test flakes under parallel gate
description: admin-portal deepLinkFocus.test.tsx times out only under the full `pnpm -r` test gate; passes in isolation; usually not a regression
---

# deepLinkFocus.test.tsx flakes under the full parallel test gate

`artifacts/admin-portal/src/pages/__tests__/deepLinkFocus.test.tsx` can fail the
release `test` gate (`pnpm -r --if-present run test`) with
`TestingLibraryElementError: Unable to find an element with the text: Widget N`.
It renders the real `TablePage → DataGrid → useDeepLinkFocus` stack (mocking only
`@/lib/api` and `@/lib/tables`); under the full parallel workspace run, CPU
contention pushes a `waitFor`/render past its timeout. The file's own comment
documents the same vector and already bumps the mobile-card test's per-test
timeout, but the `waitFor` default (~1s) is the real ceiling.

**Why:** the failure is timing/contention, not logic. It passes comfortably when
the admin-portal suite is run alone (`pnpm --filter @workspace/admin-portal run
test`).

**How to apply:** if a task that does NOT touch `TablePage`/`DataGrid`/deep-link
code sees this as the only red gate, re-run the admin-portal suite in isolation —
if it's green there, treat it as this pre-existing flake (skip the gate with a
scoped reason), not a regression. Only dig in if you actually changed the table/
grid/deep-link surface.
