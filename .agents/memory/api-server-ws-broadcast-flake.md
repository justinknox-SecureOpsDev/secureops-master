---
name: api-server WS broadcast suite flake
description: wsBroadcast.test.ts fails only under the full parallel api-server test run, not in isolation — a load-induced timing flake, not a regression.
---

`artifacts/api-server/src/__tests__/wsBroadcast.test.ts` passes reliably when
run alone (`pnpm vitest run src/__tests__/wsBroadcast.test.ts`, 9/9) but the
"elite rooms reach only admins + explicit members" / room-broadcast assertions
fail under the full parallel suite (`pnpm --filter @workspace/api-server test`),
typically `expected [] to have a length of 1`.

**Why:** the test collects WS frames with a fixed `collectFor(ws, 500)` 500ms
window after issuing the POST. Under the full suite's heavy parallel CPU/import
load (esbuild transforms + many WS files in flight), the broadcast frame can
arrive after the window closes, so a real-and-correct broadcast reads as zero.
It is a test-timing problem, not a server regression. Confirmed pre-existing:
it fails even when the dispatch/payroll/invoiceGenerate test files are excluded.

**How to apply:** if you see this fail in CI/full-suite, do NOT chase it as a
broadcast-scoping bug. Reproduce in isolation first; if it passes alone, it's
the timing window. The durable fix is to wait for an expected frame count with a
generous deadline (poll/await N messages up to a few seconds) instead of a flat
500ms sleep — applies to the `collectFor` helper and the other fixed-window
collectors in the same file.
