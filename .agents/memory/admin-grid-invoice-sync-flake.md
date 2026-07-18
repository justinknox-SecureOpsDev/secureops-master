---
name: adminGridTimeEntryInvoiceSync parallel flake
description: Full `pnpm -r` test gate can fail this suite with a 23505 duplicate-invoice unique violation; passes in isolation.
---

Under the full parallel `test` gate, `artifacts/api-server/src/__tests__/adminGridTimeEntryInvoiceSync.test.ts` can fail with `duplicate key value violates unique constraint` (23505) when manually inserting a draft invoice for a (site, week) bucket the auto invoice-sync also upserts concurrently.

**Why:** the invoice auto-sync keyed on (siteId, ISO-week) races the test's manual insert under load; timing-dependent, not a code regression.

**How to apply:** if this is the ONLY failure in a full gate run and no invoice-sync code changed, re-run the file in isolation (`vitest run src/__tests__/adminGridTimeEntryInvoiceSync.test.ts`); if it passes, restart the `test` workflow rather than changing code. Note: single-file runs can also exit -1 with no output (OOM) under concurrent dev workflows — just retry.
