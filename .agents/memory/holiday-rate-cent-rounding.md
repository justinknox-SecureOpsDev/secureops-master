---
name: Holiday premium rate cent-rounding
description: Why the federal-holiday premium rate must be cent-rounded before multiplying by hours, in every money surface.
---

# Holiday premium rate must be cent-rounded before it touches hours

When applying the federal-holiday premium (`baseRate × HOLIDAY_PAY_MULTIPLIER`),
round the result to cents **first** (`Math.round(rate * mult * 100) / 100`), then
multiply by hours for gross/amount. Do this identically in payroll
(`/payroll/generate` aggregate AND `computeBoardBuckets`) and in invoicing
(`invoiceSync` officer + subcontractor loops).

**Why:** the per-entry effective rate is surfaced to humans (Payroll Board cell,
invoice line `rate`). If gross is computed from the *unrounded* rate while the
displayed rate is rounded, "displayed rate × hours" stops equalling the stored
gross/amount on odd-cent bases (e.g. 10.01 × 1.5 = 15.015). One path rounding and
another not also drifts payroll vs invoice by a cent. An architect review caught
exactly this — payroll was multiplying the unrounded rate while invoicing rounded.

**How to apply:** any new money surface that re-derives the holiday premium (CSV
export, paystub, PDF, a new report) must round the rate to cents before
multiplying. Regression locked by the odd-cent case in `holidayPay.test.ts`.
