---
name: Invoice PDF three data paths
description: Adding a money column to invoices requires updating three separate PDF selects or the printed math won't reconcile.
---

Invoice PDFs are built from THREE separate drizzle selects that each hand-pick columns:
1. Admin "Download PDF" — `routes/invoices.ts` `GET /invoices/:id/pdf`
2. Client portal invoice download — `routes/clientPortal.ts`
3. Emailed PDF — `routes/invoices.ts` `POST /invoices/:id/send`

**Why:** `InvoicePdfInput` money fields are optional, so omitting a new column (e.g. `processingFeeAmount`) from one select still typechecks — but the printed invoice shows a `totalAmount` that includes a charge with no visible line, and the same invoice renders differently emailed vs downloaded. This bit the processing-fee rollout (2 of 3 paths were missed until review).

**How to apply:** Any new invoice money/display column must be added to all three selects (and the explicit clientPortal buildInvoicePdf object) in the same change; grep for `buildInvoicePdf(` to find the callers.
