---
name: Invoice number random-suffix collision flake
description: generateInvoiceNumber uses a random 4-digit suffix; unique-constraint 23505 flakes under the full api-server suite are collisions, not regressions.
---

`generateInvoiceNumber()` (duplicated in invoiceSync.ts and routes/invoices.ts)
builds `INV-YYYYMM-<random 4 digits>`. `invoices.invoice_number` is UNIQUE, so
two invoices created in the same month have a ~1/10000-per-pair collision
chance. Under the full api-server test run (which creates many invoices), this
occasionally throws 23505 `invoices_invoice_number_unique` inside
`upsertWeeklyInvoice` — e.g. a holidayPay test failing while passing alone.

**Why:** random suffix has no retry/sequence; the collision is real but rare.
It is also a latent production bug, not just a test flake.

**How to apply:** if a test fails with a 23505 on the invoice-number unique
constraint, re-run alone before suspecting the code under test. A proper fix
is a retry-on-23505 loop or a DB sequence for the suffix, applied to BOTH
copies of the generator.
