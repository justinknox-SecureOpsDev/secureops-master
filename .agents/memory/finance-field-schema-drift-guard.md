---
name: Finance field-name allowlist needs a schema-drift guard
description: Field-name-based money-stripping (DASHBOARD_FINANCE_FIELDS, stripShiftFinanceForRole) silently misses new numeric columns; pair it with a getTableColumns-based test.
---

Any sanitizer that strips money fields by matching an explicit field-name
list (e.g. `DASHBOARD_FINANCE_FIELDS` in
`artifacts/api-server/src/lib/financeVisibility.ts`) only protects fields
someone remembered to add to the list. A new `numeric`-typed column on the
underlying Drizzle table is invisible to that list until a human notices.

**Why:** found a case where `taxAmount`, `processingFeeRate`,
`processingFeeAmount`, `tax`, and `lineItems` were already selected into the
GET /payroll and GET /invoices list responses and reached a non-owner
bookkeeper unstripped — only `grossPay`/`netPay`/`subtotal`/`totalAmount`
were covered, because those were the only fields anyone had thought to test.

**How to apply:** pair every field-name-based money strip with a schema-level
regression test that uses drizzle-orm's `getTableColumns(table)` to enumerate
every column with `columnType === "PgNumeric"`, then asserts each one is
either in the strip set or an explicit, commented allowlist (e.g. a
per-record rate like `hourlyRate`/`payRate` that's intentionally visible to
non-owner internal staff — a different, role-based axis). This turns "add a
money column, forget the strip list" into an immediate failing test instead
of a silent leak. See the "Every numeric column..." describe block in
`artifacts/api-server/src/__tests__/companyOwnerAndPermissions.test.ts` for
the pattern. The same gap likely exists on the OTHER (role-based) axis —
`stripShiftFinanceForRole`/`stripTimeEntryBillRateForRole` also destructure a
hardcoded field list rather than checking the schema (tracked as a follow-up,
not yet fixed).
