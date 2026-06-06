---
name: Payroll 1099 — no tax withholding
description: WCSG workers are all 1099 contractors, so payroll must never withhold tax — net always equals gross, enforced at every surface.
---

# 1099 contractors — payroll never withholds tax

Every WCSG worker is a 1099 independent contractor. Payroll/invoicing must **never**
withhold tax: `tax = 0` and `netPay = grossPay` everywhere, always.

**Why:** the platform originally applied a flat 20% withholding in the payroll
compute paths. Because the workforce is 100% 1099, that was always wrong — the user
reported officers being underpaid. There is no scenario where this app should
withhold tax.

**How to apply:** the invariant must hold across THREE surface classes, not just the
compute path — fixing only one leaves legacy stored rows leaking. When touching
payroll, keep all of these consistent:

1. **Compute** (new rows): payroll generate + pay-run board process set `tax=0`, `net=gross`.
2. **Read** (display/pay): the `/payroll` list, the pay-run preview/export loader,
   officer `/me/payroll` (rows + YTD/lifetime), and the admin CSV export dataset all
   **normalize on read** (`tax→0`, `netPay→grossPay`) so any legacy row stored with
   old withholding still shows/pays full gross. The prod DB is not directly writable
   from the agent env, so read-time normalization (plus stamping the correction onto
   rows at CSV-export claim time) is the chosen mitigation instead of a one-off backfill.
3. **Write** (reintroduction guard): the generic admin CRUD `coerceWrite` for
   `payroll_entries` forces `tax="0"` and `netPay=grossPay`, and the editable Tax
   field is removed from the admin table config, so a manual edit/import can't
   reintroduce withholding.

The DB still has a `tax` column and the API still returns a `tax` field — both are
just always `0` (kept to avoid contract/schema churn). Do NOT drop the column.
