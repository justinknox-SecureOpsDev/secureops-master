---
name: Payroll + invoice weeks bucket by business TZ
description: Why payroll generation, the Payroll Board, and invoicing all window/bucket by Central weeks, not UTC Mondays
---

Payroll generation (`POST /payroll/generate`), the Payroll Board (`computeBoardBuckets` + the process-selected handoff), and invoicing (`lib/invoiceSync.ts` — `upsertWeeklyInvoice` / `weekStartIsoBusiness`) all bucket time entries by the **business-TZ (Central / PAYROLL_TIMEZONE) week**, via `startOfBusinessWeek` from `lib/businessTime.ts`. The analytics summary trend does too.

**Why:** they previously windowed/bucketed by naive UTC Mondays while the officer time card (`buildTimeCard`) uses business-TZ weeks. An entry clocked Sunday evening Central is already Monday in UTC, so the surfaces put it in different weeks — the officer's time card showed the hours in one week while payroll/invoicing landed them in the next (risking double-pay, a dropped sliver, or a chart-vs-invoice gap).

**How to apply:** any new payroll/board/invoice week-bucketing must go through `startOfBusinessWeek` (or its callers `mondayOfWeekUTC` for payroll, `weekStartIsoBusiness` for invoices) — never `getUTCDay()` / `new Date(weekStart+"T00:00:00Z")` UTC math. `mondayOfWeekUTC` and `weekStartIsoBusiness` keep older-flavored names but return the Central Monday (as a UTC instant / ISO date respectively).

**Now uniform:** payroll, Payroll Board, invoices, officer time card, and the analytics summary trend share the identical Central week boundary, so the Sunday-evening-Central sliver bills/pays/charts in the same week everywhere. (Analytics officer-history still LABELS the week as ISO `YYYY-Www`, but truncates in-TZ so the boundary still matches.)
