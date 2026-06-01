---
name: Pay-run export must atomic-claim before emitting payment lines
description: Outbound payment files (ACH CSV) must build rows from an atomic status-claim, not a separate read-then-update, or downstream states re-export and concurrent exports duplicate.
---

# Pay-run / AP export: claim-then-build, never read-then-build

Any endpoint that emits an outbound payment file (officer Pay Run, subcontractor
Pay Run, future AP runs) must build the file's rows from the result of an atomic
state transition, not from a prior `SELECT`.

Correct pattern:
1. Load candidates + compute warnings (bank info, consent, amount).
2. Eligible = rows in the **single** payable status (`approved`) with no warnings.
3. `UPDATE ... SET status='processed' ... WHERE id IN (eligible) AND status='approved' RETURNING id`.
4. Build the CSV **only** from the returned (claimed) ids. If none claimed → 409.

Two bugs this prevents:
- **Re-export of downstream rows:** if the payable filter is `status != 'paid'`,
  a `processed` row (no warnings) gets re-emitted into a fresh CSV while the
  `WHERE status='approved'` update no-ops → a second real payment file for an
  already-paid-out invoice. Restrict export eligibility to `approved` ONLY.
- **Concurrent double-claim:** two simultaneous exports both read the same
  `approved` rows and both emit lines. RETURNING makes only the winner's request
  contain the row; the loser claims nothing.

Also gate `mark-paid` to legitimate source states (`approved`, `processed`) via
`inArray(status, [...])` — never `status <> 'paid'`, which would let
pending/rejected/failed jump straight to paid.

**Why:** money leaves a bank from these files; a duplicate or out-of-state line
is a real double-payment. **How to apply:** mirror this whenever cloning a
pay-run/AP flow. Both pay-runs now use this hardened pattern: officer Pay Run
(`routes/payroll.ts`, payable state `pending`) and subcontractor Pay Run
(`routes/subcontractorPayRun.ts`, payable state `approved`). Keep any new
pay-run/AP export consistent with them.
